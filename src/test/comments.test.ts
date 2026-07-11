import request from "supertest";
import { app } from "../app";
import { extractCookie } from "./testUtils";

// Same shared-authLimiter caveat as pagination.test.ts: signup+login+refresh
// share one rate-limit bucket (10 req/15min across all three combined).
// This file uses only 3 signupAndLogin pairs (6 requests) to stay well
// under that budget.

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

async function createIssue(
  cookie: string,
  organizationId: string,
  projectId: string,
  title: string,
): Promise<string> {
  const res = await request(app)
    .post(`/api/organizations/${organizationId}/issues`)
    .set("Cookie", [cookie])
    .send({ title, projectId });
  return res.body.id as string;
}

describe("comments", () => {
  it("full CRUD lifecycle, and rejects an empty body", async () => {
    const cookie = await signupAndLogin("comments-user@example.com");
    const orgId = await createOrg(cookie, "Comments Org");
    const projectId = await createProject(cookie, orgId, "Comments Project");
    const issueId = await createIssue(
      cookie,
      orgId,
      projectId,
      "Issue with comments",
    );

    const emptyBodyRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("Cookie", [cookie])
      .send({ body: "" });
    expect(emptyBodyRes.status).toBe(400);

    const createRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("Cookie", [cookie])
      .send({ body: "First comment" });

    expect(createRes.status).toBe(201);
    expect(createRes.body.body).toBe("First comment");
    expect(createRes.body.author).toBeDefined();
    const commentId = createRes.body.id as string;

    const listRes = await request(app)
      .get(`/api/issues/${issueId}/comments`)
      .set("Cookie", [cookie]);

    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBe(1);
    expect(listRes.body.data[0].id).toBe(commentId);

    const editRes = await request(app)
      .patch(`/api/comments/${commentId}`)
      .set("Cookie", [cookie])
      .send({ body: "Edited comment" });

    expect(editRes.status).toBe(200);
    expect(editRes.body.body).toBe("Edited comment");

    const deleteRes = await request(app)
      .delete(`/api/comments/${commentId}`)
      .set("Cookie", [cookie]);

    expect(deleteRes.status).toBe(204);

    const listAfterDelete = await request(app)
      .get(`/api/issues/${issueId}/comments`)
      .set("Cookie", [cookie]);

    expect(listAfterDelete.body.data.length).toBe(0);
  });

  it("blocks a non-member from reading/writing, and blocks editing/deleting someone else's comment", async () => {
    const ownerCookie = await signupAndLogin("comments-owner@example.com");
    const outsiderCookie = await signupAndLogin(
      "comments-outsider@example.com",
    );

    const orgId = await createOrg(ownerCookie, "Private Org");
    const projectId = await createProject(
      ownerCookie,
      orgId,
      "Private Project",
    );
    const issueId = await createIssue(
      ownerCookie,
      orgId,
      projectId,
      "Private Issue",
    );

    const commentRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("Cookie", [ownerCookie])
      .send({ body: "Owner's comment" });
    expect(commentRes.status).toBe(201);
    const commentId = commentRes.body.id as string;

    // Outsider has no membership in this org at all — requireRole should
    // reject before any ownership check is reached.
    const readAttempt = await request(app)
      .get(`/api/issues/${issueId}/comments`)
      .set("Cookie", [outsiderCookie]);
    expect(readAttempt.status).toBe(403);

    const writeAttempt = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("Cookie", [outsiderCookie])
      .send({ body: "Trying to comment from outside" });
    expect(writeAttempt.status).toBe(403);

    const editAttempt = await request(app)
      .patch(`/api/comments/${commentId}`)
      .set("Cookie", [outsiderCookie])
      .send({ body: "Hijacked edit" });
    expect(editAttempt.status).toBe(403);

    const deleteAttempt = await request(app)
      .delete(`/api/comments/${commentId}`)
      .set("Cookie", [outsiderCookie]);
    expect(deleteAttempt.status).toBe(403);
  });
});
