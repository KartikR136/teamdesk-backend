import request from "supertest";
import jwt from "jsonwebtoken";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { extractCookie } from "./testUtils";

// This file exists to close a real gap found during M4's test-suite audit:
// ARCHITECTURE.md names "JWTs carry only identity, never roles" as one of
// three mechanisms enforcing the core multi-tenancy invariant, but until
// now it had zero automated coverage — it had only ever been demonstrated
// once, manually, via the M1 Attack Console's `forged-role-in-jwt`
// scenario, which isn't part of this suite or CI. This test makes that
// same scenario permanent and automatic.

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

describe("JWT role-claim forgery", () => {
  it("ignores an injected role claim even in a validly-signed token — role is always re-derived from the database", async () => {
    // Org creator becomes ADMIN (per API.md) — used only to create the org
    // and issue the MEMBER+ -gated action the forged token will attempt.
    const adminSignup = await request(app).post("/api/auth/signup").send({
      email: "jwt-forgery-admin@example.com",
      password: "correctpassword",
      name: "Admin",
    });
    const adminLogin = await request(app).post("/api/auth/login").send({
      email: "jwt-forgery-admin@example.com",
      password: "correctpassword",
    });
    const adminCookie = extractCookie(
      adminLogin.headers["set-cookie"],
      "accessToken",
    );

    const orgRes = await request(app)
      .post("/api/organizations")
      .set("Cookie", [adminCookie])
      .send({ name: "JWT Forgery Org", slug: slugify("JWT Forgery Org") });
    const orgId = orgRes.body.id as string;

    const projectRes = await request(app)
      .post(`/api/organizations/${orgId}/projects`)
      .set("Cookie", [adminCookie])
      .send({ name: "Project" });
    const projectId = projectRes.body.id as string;

    // Second user, signed up but never logged in via the real login route —
    // manually seeded as a VIEWER, well below the MEMBER rank needed to
    // create an issue.
    const viewerSignup = await request(app).post("/api/auth/signup").send({
      email: "jwt-forgery-viewer@example.com",
      password: "correctpassword",
      name: "Viewer",
    });
    const viewerUserId = viewerSignup.body.id as string;
    await prisma.membership.create({
      data: { userId: viewerUserId, organizationId: orgId, role: "VIEWER" },
    });

    // Sanity check: this VIEWER genuinely cannot create an issue with a
    // real, unforged token for their actual role.
    const realViewerCookie = extractCookie(
      viewerSignup.headers["set-cookie"],
      "accessToken",
    );
    const realAttempt = await request(app)
      .post(`/api/organizations/${orgId}/issues`)
      .set("Cookie", [realViewerCookie])
      .send({ title: "Should fail — real VIEWER token", projectId });
    expect(realAttempt.status).toBe(403);

    // The actual test: a token for the SAME user, validly signed with the
    // real secret (not a signature-forgery attempt), but with an extra,
    // unsolicited role claim injected into the payload. AccessTokenPayload
    // is typed to carry only { userId } — if requireAuth or requireRole
    // ever read a role off the token instead of the database, this would
    // succeed. It must not.
    const forgedToken = jwt.sign(
      { userId: viewerUserId, role: "ADMIN" },
      env.jwtAccessSecret!,
      { expiresIn: "15m" },
    );

    const forgedAttempt = await request(app)
      .post(`/api/organizations/${orgId}/issues`)
      .set("Cookie", [`accessToken=${forgedToken}`])
      .send({ title: "Should still fail — forged role claim", projectId });

    expect(forgedAttempt.status).toBe(403);
  });
});
