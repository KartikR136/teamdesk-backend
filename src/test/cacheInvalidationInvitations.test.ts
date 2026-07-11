import request from "supertest";
import { app } from "../app";
import { extractCookie } from "./testUtils";

async function signupAndLogin(email: string): Promise<string> {
  await request(app).post("/api/auth/signup").send({
    email,
    password: "correctpassword",
    name: "Test User",
  });

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

describe("Redis cache invalidation — invitation acceptance", () => {
  it("immediately grants access after accepting — no stale negative-cache window", async () => {
    const adminCookie = await signupAndLogin("cache-invite-admin@example.com");
    const orgId = await createOrg(adminCookie, "Cache Invite Org");

    const inviteeCookie = await signupAndLogin(
      "cache-invite-invitee@example.com",
    );

    // Before being invited, the invitee has no membership. This request
    // primes a NEGATIVE cache entry for (inviteeId, orgId) — "not a member".
    const beforeInviteRes = await request(app)
      .get(`/api/organizations/${orgId}/issues`)
      .set("Cookie", [inviteeCookie]);
    expect(beforeInviteRes.status).toBe(403);

    const inviteRes = await request(app)
      .post(`/api/organizations/${orgId}/invitations`)
      .set("Cookie", [adminCookie])
      .send({ email: "cache-invite-invitee@example.com", role: "MEMBER" });
    const invitationId = inviteRes.body.id as string;

    const acceptRes = await request(app)
      .post(`/api/invitations/${invitationId}/accept`)
      .set("Cookie", [inviteeCookie]);
    expect(acceptRes.status).toBe(201);

    // Without invalidating the negative cache entry from before the invite,
    // this could still 403 for up to 60s even though membership now exists.
    const afterAcceptRes = await request(app)
      .get(`/api/organizations/${orgId}/issues`)
      .set("Cookie", [inviteeCookie]);
    expect(afterAcceptRes.status).toBe(200);
  });
});
