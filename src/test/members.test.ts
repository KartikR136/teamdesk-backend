import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { extractCookie } from "./testUtils";

// Separate file from invitations.test.ts so this gets its own authLimiter
// budget (Jest resets the module registry, and this rate limiter's in-memory
// store, per test file).

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

describe("members", () => {
  it("lists members, allows admin role changes, guards the last admin, and forbids non-admins from changing roles", async () => {
    const adminCookie = await signupAndLogin("members-admin@example.com");
    const orgId = await createOrg(adminCookie, "Members Org");

    // Target user is created but not yet logged in — signup() alone is
    // enough to get their id for direct membership seeding.
    const targetUserId = await signup("members-target@example.com");

    // Seeded directly via Prisma rather than through the invite/accept HTTP
    // flow — this test is about role-change authorization, not invitations,
    // and going through invite+accept here would cost 2 more requests
    // against this file's rate-limit budget for no added coverage.
    await prisma.membership.create({
      data: { userId: targetUserId, organizationId: orgId, role: "MEMBER" },
    });

    const listRes = await request(app)
      .get(`/api/organizations/${orgId}/members`)
      .set("Cookie", [adminCookie]);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBe(2);

    const changeRoleRes = await request(app)
      .patch(`/api/organizations/${orgId}/members/${targetUserId}`)
      .set("Cookie", [adminCookie])
      .send({ role: "MANAGER" });
    expect(changeRoleRes.status).toBe(200);
    expect(changeRoleRes.body.role).toBe("MANAGER");

    // The admin is still the ONLY admin in this org — demoting themselves
    // must be blocked, or the org becomes unmanageable.
    const adminMembership = await prisma.membership.findFirst({
      where: { organizationId: orgId, role: "ADMIN" },
    });
    const lastAdminAttempt = await request(app)
      .patch(`/api/organizations/${orgId}/members/${adminMembership!.userId}`)
      .set("Cookie", [adminCookie])
      .send({ role: "MEMBER" });
    expect(lastAdminAttempt.status).toBe(400);

    // The target (now MANAGER, not ADMIN) should not be able to change
    // anyone else's role.
    const targetCookie = await login("members-target@example.com");
    const forbiddenAttempt = await request(app)
      .patch(`/api/organizations/${orgId}/members/${adminMembership!.userId}`)
      .set("Cookie", [targetCookie])
      .send({ role: "VIEWER" });
    expect(forbiddenAttempt.status).toBe(403);

    // Non-admins can't remove members either.
    const forbiddenRemoveAttempt = await request(app)
      .delete(`/api/organizations/${orgId}/members/${adminMembership!.userId}`)
      .set("Cookie", [targetCookie]);
    expect(forbiddenRemoveAttempt.status).toBe(403);

    // Admin removes the target for real.
    const removeRes = await request(app)
      .delete(`/api/organizations/${orgId}/members/${targetUserId}`)
      .set("Cookie", [adminCookie]);
    expect(removeRes.status).toBe(204);

    const listAfterRemoval = await request(app)
      .get(`/api/organizations/${orgId}/members`)
      .set("Cookie", [adminCookie]);
    expect(listAfterRemoval.body.data.length).toBe(1);

    // The admin is (still) the org's only admin — removing themselves must
    // be blocked, same lockout rule as the role-change guard above.
    const removeLastAdminAttempt = await request(app)
      .delete(`/api/organizations/${orgId}/members/${adminMembership!.userId}`)
      .set("Cookie", [adminCookie]);
    expect(removeLastAdminAttempt.status).toBe(400);
  });

  it("blocks a non-member from viewing the members list", async () => {
    const ownerCookie = await signupAndLogin("members-owner@example.com");
    const outsiderCookie = await signupAndLogin("members-outsider@example.com");

    const orgId = await createOrg(ownerCookie, "Private Members Org");

    const attempt = await request(app)
      .get(`/api/organizations/${orgId}/members`)
      .set("Cookie", [outsiderCookie]);
    expect(attempt.status).toBe(403);
  });
});
