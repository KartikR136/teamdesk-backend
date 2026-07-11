import request from "supertest";
import { app } from "../app";
import { extractCookie } from "./testUtils";
import type { Response } from "supertest";

// Same shared-authLimiter caveat as the other test files in this suite:
// signup+login+refresh share one 10-req/15min bucket. This file uses 2
// signupAndLogin pairs (4 requests) to stay well under that budget.

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

describe("activity log", () => {
  it("records org/project/issue/comment mutations and exposes them via the paginated feed", async () => {
    const cookie = await signupAndLogin("activity-user@example.com");

    // Every one of these mutations should produce exactly one ActivityLog row.
    const orgId = await createOrg(cookie, "Activity Org");
    const projectId = await createProject(cookie, orgId, "Activity Project");
    const issueId = await createIssue(
      cookie,
      orgId,
      projectId,
      "Activity Issue",
    );

    await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("Cookie", [cookie])
      .send({ status: "IN_PROGRESS" });

    const commentRes = await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .set("Cookie", [cookie])
      .send({ body: "First comment" });
    const commentId = commentRes.body.id as string;

    await request(app)
      .patch(`/api/comments/${commentId}`)
      .set("Cookie", [cookie])
      .send({ body: "Edited comment" });

    await request(app)
      .delete(`/api/comments/${commentId}`)
      .set("Cookie", [cookie]);

    // Page through the full activity feed rather than assuming it all fits
    // in one page, exercising the same cursor-pagination contract as M1.
    const allEntries: Array<{ action: string; issueId: string | null }> = [];
    let cursor: string | null = null;
    let pageCount = 0;

    do {
      const res: Response = await request(app)
        .get(`/api/organizations/${orgId}/activity`)
        .query({ limit: 3, ...(cursor ? { cursor } : {}) })
        .set("Cookie", [cookie]);

      expect(res.status).toBe(200);
      allEntries.push(...res.body.data);
      expect(res.body.hasNextPage).toBe(Boolean(res.body.nextCursor));

      cursor = res.body.nextCursor;
      pageCount++;
      expect(pageCount).toBeLessThan(10); // safety valve
    } while (cursor);

    // Exactly one entry per mutation — 7 total, no duplicates, none dropped.
    expect(allEntries.length).toBe(7);

    const actions = allEntries.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "ORGANIZATION_CREATED",
        "PROJECT_CREATED",
        "ISSUE_CREATED",
        "ISSUE_UPDATED",
        "COMMENT_CREATED",
        "COMMENT_UPDATED",
        "COMMENT_DELETED",
      ]),
    );

    // Issue/comment-scoped events should carry the issueId; org/project
    // creation events have no associated issue.
    const issueCreatedEntry = allEntries.find(
      (e) => e.action === "ISSUE_CREATED",
    );
    expect(issueCreatedEntry?.issueId).toBe(issueId);

    const commentDeletedEntry = allEntries.find(
      (e) => e.action === "COMMENT_DELETED",
    );
    expect(commentDeletedEntry?.issueId).toBe(issueId);

    const orgCreatedEntry = allEntries.find(
      (e) => e.action === "ORGANIZATION_CREATED",
    );
    expect(orgCreatedEntry?.issueId ?? null).toBeNull();
  });

  it("blocks a non-member from reading another organization's activity feed", async () => {
    const ownerCookie = await signupAndLogin("activity-owner@example.com");
    const outsiderCookie = await signupAndLogin(
      "activity-outsider@example.com",
    );

    const orgId = await createOrg(ownerCookie, "Private Activity Org");

    const attempt = await request(app)
      .get(`/api/organizations/${orgId}/activity`)
      .set("Cookie", [outsiderCookie]);

    expect(attempt.status).toBe(403);
  });
});
