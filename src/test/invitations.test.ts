import request from "supertest";
import { app } from "../app";
import { extractCookie } from "./testUtils";

// This file uses 2 signupAndLogin pairs per test (8 total requests), staying
// under the shared authLimiter budget (10 req/15min across signup+login+refresh).

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

describe("invitations", () => {
  it("invites, blocks duplicates/already-members, and lets the invitee accept", async () => {
    const adminCookie = await signupAndLogin("invite-admin@example.com");
    const orgId = await createOrg(adminCookie, "Invite Org");

    const inviteRes = await request(app)
      .post(`/api/organizations/${orgId}/invitations`)
      .set("Cookie", [adminCookie])
      .send({ email: "invitee@example.com", role: "MEMBER" });
    expect(inviteRes.status).toBe(201);
    const invitationId = inviteRes.body.id as string;

    // Duplicate pending invite for the same email should be blocked.
    const duplicateRes = await request(app)
      .post(`/api/organizations/${orgId}/invitations`)
      .set("Cookie", [adminCookie])
      .send({ email: "invitee@example.com", role: "MEMBER" });
    expect(duplicateRes.status).toBe(400);

    // Inviting someone who's already a member (the admin themselves) should
    // be blocked too.
    const alreadyMemberRes = await request(app)
      .post(`/api/organizations/${orgId}/invitations`)
      .set("Cookie", [adminCookie])
      .send({ email: "invite-admin@example.com", role: "MEMBER" });
    expect(alreadyMemberRes.status).toBe(400);

    // The invitee signs up with the exact email the invitation was sent to,
    // and should see it in their own invitation inbox.
    const inviteeCookie = await signupAndLogin("invitee@example.com");

    const myInvitesRes = await request(app)
      .get("/api/invitations/me")
      .set("Cookie", [inviteeCookie]);
    expect(myInvitesRes.status).toBe(200);
    expect(
      myInvitesRes.body.some((i: { id: string }) => i.id === invitationId),
    ).toBe(true);

    const acceptRes = await request(app)
      .post(`/api/invitations/${invitationId}/accept`)
      .set("Cookie", [inviteeCookie]);
    expect(acceptRes.status).toBe(201);
    expect(acceptRes.body.role).toBe("MEMBER");
    expect(acceptRes.body.organizationId).toBe(orgId);

    // Accepting again should fail — invitation is no longer PENDING.
    const acceptAgainRes = await request(app)
      .post(`/api/invitations/${invitationId}/accept`)
      .set("Cookie", [inviteeCookie]);
    expect(acceptAgainRes.status).toBe(400);
  });

  it("blocks the wrong recipient from accepting, and lets the real invitee reject", async () => {
    const adminCookie = await signupAndLogin("reject-admin@example.com");
    const orgId = await createOrg(adminCookie, "Reject Org");

    const inviteRes = await request(app)
      .post(`/api/organizations/${orgId}/invitations`)
      .set("Cookie", [adminCookie])
      .send({ email: "reject-invitee@example.com", role: "VIEWER" });
    const invitationId = inviteRes.body.id as string;

    // The admin's own email doesn't match the invitation — even though
    // they're an org admin, they aren't the invitee, so acceptance must
    // be blocked. This reuses adminCookie instead of a third signup to
    // stay within this file's rate-limit budget.
    const wrongAcceptRes = await request(app)
      .post(`/api/invitations/${invitationId}/accept`)
      .set("Cookie", [adminCookie]);
    expect(wrongAcceptRes.status).toBe(403);

    const inviteeCookie = await signupAndLogin("reject-invitee@example.com");

    const rejectRes = await request(app)
      .post(`/api/invitations/${invitationId}/reject`)
      .set("Cookie", [inviteeCookie]);
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe("REJECTED");

    // Once rejected, it's no longer accept-able.
    const acceptAfterRejectRes = await request(app)
      .post(`/api/invitations/${invitationId}/accept`)
      .set("Cookie", [inviteeCookie]);
    expect(acceptAfterRejectRes.status).toBe(400);

    // And it should no longer show up in the org's PENDING invitations list.
    const orgInvitesRes = await request(app)
      .get(`/api/organizations/${orgId}/invitations`)
      .set("Cookie", [adminCookie]);
    expect(orgInvitesRes.body.data.length).toBe(0);
  });
});
