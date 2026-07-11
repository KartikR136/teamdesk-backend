import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { extractCookie } from "./testUtils";

// Separate file from cacheInvalidationInvitations.test.ts so each gets its
// own authLimiter budget (Jest resets the module registry — and this rate
// limiter's in-memory store — per test file).

async function signup(email: string): Promise<string> {
  const res = await request(app).post("/api/auth/signup").send({
    email,
    password: "correctpassword",
    name: "Test User",
  });
  return res.body.id as string;
}

async function login(email: string): Promise<string> {
  const loginRes = await request(app).post("/api/auth/login").send({
    email,
    password: "correctpassword",
  });
  const setCookie = loginRes.headers["set-cookie"];
  if (!setCookie) {
    throw new Error(
      `Login for ${email} returned no set-cookie header (status ${loginRes.status}, ` +
        `body: ${JSON.stringify(loginRes.body)}).`,
    );
  }
  return extractCookie(setCookie, "accessToken");
}

async function signupAndLogin(email: string): Promise<string> {
  await signup(email);
  return login(email);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function createOrg(cookie: string, name: string): Promise<string> {
  const res = await request(app)
    .post("/api/organizations")
    .set("Cookie", [cookie])
    .send({ name, slug: slugify(name) });
  if (res.status !== 201) {
    throw new Error(`createOrg failed: ${JSON.stringify(res.body)}`);
  }
  return res.body.id as string;
}

async function createProject(
  cookie: string,
  organizationId: string,
  name: string,
): Promise<string> {
  const res = await request(app)
    .post(`/api/organizations/${organizationId}/projects`)
    .set("Cookie", [cookie])
    .send({ name });
  return res.body.id as string;
}

describe("Redis cache invalidation — role change and member removal", () => {
  it("immediately revokes access after a demote — no 60s stale-role window", async () => {
    const adminCookie = await signupAndLogin("cache-demote-admin@example.com");
    const orgId = await createOrg(adminCookie, "Cache Demote Org");
    const projectId = await createProject(adminCookie, orgId, "Project");

    const targetUserId = await signup("cache-demote-target@example.com");
    await prisma.membership.create({
      data: { userId: targetUserId, organizationId: orgId, role: "MEMBER" },
    });
    const targetCookie = await login("cache-demote-target@example.com");

    // Prime the Redis cache with the target's current (MEMBER) role by
    // making a MEMBER-gated request succeed.
    const primeRes = await request(app)
      .post(`/api/organizations/${orgId}/issues`)
      .set("Cookie", [targetCookie])
      .send({ title: "Issue while still MEMBER", projectId });
    expect(primeRes.status).toBe(201);

    // Demote to VIEWER — below MEMBER, so issue creation should now be
    // rejected. Without cache invalidation, the cached MEMBER role could
    // still be read for up to 60s, letting this next call wrongly succeed.
    const demoteRes = await request(app)
      .patch(`/api/organizations/${orgId}/members/${targetUserId}`)
      .set("Cookie", [adminCookie])
      .send({ role: "VIEWER" });
    expect(demoteRes.status).toBe(200);

    const attemptAfterDemote = await request(app)
      .post(`/api/organizations/${orgId}/issues`)
      .set("Cookie", [targetCookie])
      .send({ title: "Issue after demote — should be blocked", projectId });
    expect(attemptAfterDemote.status).toBe(403);
  });

  it("immediately revokes access after removal — no 60s stale-membership window", async () => {
    const adminCookie = await signupAndLogin("cache-remove-admin@example.com");
    const orgId = await createOrg(adminCookie, "Cache Remove Org");

    const targetUserId = await signup("cache-remove-target@example.com");
    await prisma.membership.create({
      data: { userId: targetUserId, organizationId: orgId, role: "VIEWER" },
    });
    const targetCookie = await login("cache-remove-target@example.com");

    // Prime the cache with a positive membership lookup.
    const primeRes = await request(app)
      .get(`/api/organizations/${orgId}/issues`)
      .set("Cookie", [targetCookie]);
    expect(primeRes.status).toBe(200);

    const removeRes = await request(app)
      .delete(`/api/organizations/${orgId}/members/${targetUserId}`)
      .set("Cookie", [adminCookie]);
    expect(removeRes.status).toBe(204);

    // Without invalidation, this could still succeed for up to 60s on a
    // membership that's fully gone from the database.
    const attemptAfterRemoval = await request(app)
      .get(`/api/organizations/${orgId}/issues`)
      .set("Cookie", [targetCookie]);
    expect(attemptAfterRemoval.status).toBe(403);
  });
});
