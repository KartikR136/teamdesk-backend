import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";

describe("Role-based access control", () => {
  it("blocks a VIEWER from creating a project", async () => {
    const adminSignup = await request(app).post("/api/auth/signup").send({
      email: "admin@example.com",
      password: "password123",
      name: "Admin",
    });
    const adminCookies = adminSignup.headers["set-cookie"];

    const org = await request(app)
      .post("/api/organizations")
      .set("Cookie", adminCookies)
      .send({ name: "RBAC Org", slug: "rbac-org" });

    const viewerSignup = await request(app).post("/api/auth/signup").send({
      email: "viewer@example.com",
      password: "password123",
      name: "Viewer",
    });
    const viewerCookies = viewerSignup.headers["set-cookie"];
    const viewerUser = await request(app)
      .get("/api/auth/me")
      .set("Cookie", viewerCookies);

    // Manually insert a VIEWER membership (no invite endpoint built yet).
    await prisma.membership.create({
      data: {
        userId: viewerUser.body.id,
        organizationId: org.body.id,
        role: "VIEWER",
      },
    });

    const res = await request(app)
      .post(`/api/organizations/${org.body.id}/projects`)
      .set("Cookie", viewerCookies)
      .send({ name: "Should fail" });

    expect(res.status).toBe(403);
  });
});
