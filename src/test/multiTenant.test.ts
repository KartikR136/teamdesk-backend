import request from "supertest";
import { app } from "../app";

async function signupAndGetCookies(email: string) {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({
      email,
      password: "password123",
      name: email.split("@")[0],
    });
  return res.headers["set-cookie"];
}

describe("Multi-tenant isolation", () => {
  it("blocks a user from accessing another org's projects", async () => {
    const cookiesA = await signupAndGetCookies("usera@example.com");
    const cookiesB = await signupAndGetCookies("userb@example.com");

    const orgA = await request(app)
      .post("/api/organizations")
      .set("Cookie", cookiesA)
      .send({ name: "Org A", slug: "org-a" });

    // User B (not a member of Org A) tries to read Org A's projects.
    const res = await request(app)
      .get(`/api/organizations/${orgA.body.id}/projects`)
      .set("Cookie", cookiesB);

    expect(res.status).toBe(403);
  });

  it("blocks issue creation using a projectId from a different org", async () => {
    const cookiesA = await signupAndGetCookies("usera2@example.com");

    const orgA = await request(app)
      .post("/api/organizations")
      .set("Cookie", cookiesA)
      .send({ name: "Org A2", slug: "org-a2" });
    const orgB = await request(app)
      .post("/api/organizations")
      .set("Cookie", cookiesA)
      .send({ name: "Org B2", slug: "org-b2" });

    const projectInB = await request(app)
      .post(`/api/organizations/${orgB.body.id}/projects`)
      .set("Cookie", cookiesA)
      .send({ name: "Project in B" });

    // Attempt: create an issue "in" Org A, but pointing at Org B's project.
    const res = await request(app)
      .post(`/api/organizations/${orgA.body.id}/issues`)
      .set("Cookie", cookiesA)
      .send({ title: "Sneaky issue", projectId: projectInB.body.id });

    expect(res.status).toBe(404); // project not found *within Org A's context*
  });

  it("blocks PATCH on an issue belonging to another org, even with a guessed valid ID", async () => {
    const cookiesA = await signupAndGetCookies("usera3@example.com");
    const cookiesB = await signupAndGetCookies("userb3@example.com");

    const orgA = await request(app)
      .post("/api/organizations")
      .set("Cookie", cookiesA)
      .send({ name: "Org A3", slug: "org-a3" });
    const project = await request(app)
      .post(`/api/organizations/${orgA.body.id}/projects`)
      .set("Cookie", cookiesA)
      .send({ name: "P" });
    const issue = await request(app)
      .post(`/api/organizations/${orgA.body.id}/issues`)
      .set("Cookie", cookiesA)
      .send({ title: "Issue", projectId: project.body.id });

    // User B has no membership in Org A at all.
    const res = await request(app)
      .patch(`/api/issues/${issue.body.id}`)
      .set("Cookie", cookiesB)
      .send({ status: "DONE" });

    expect(res.status).toBe(403);
  });
});
