import request from "supertest";
import { app } from "../app";
import { extractCookie } from "./testUtils";
import type { Response } from "supertest";

// NOTE: authLimiter in app.ts is mounted on /login, /signup, AND /refresh as
// the same middleware instance, so express-rate-limit's default (IP-keyed,
// not route-keyed) store treats all three as ONE shared counter — 10 requests
// per 15 min total across signup+login+refresh combined, not 10 each. Every
// signupAndLogin() call below costs 2 against that shared budget. Tests are
// structured to share a single user wherever isolation isn't required, to
// stay comfortably under that limit within this file.

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

  const setCookie = loginRes.headers["set-cookie"] as unknown as string[];
  if (!setCookie) {
    throw new Error(
      `Login for ${email} returned no set-cookie header (status ${loginRes.status}, ` +
        `body: ${JSON.stringify(loginRes.body)}). If status is 429, this file's ` +
        `signup+login calls exceeded the shared authLimiter budget (10 req/15min ` +
        `combined across /signup, /login, /refresh) — reduce the number of ` +
        `signupAndLogin() calls in this file or run it alone.`,
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
    throw new Error(
      `createOrg failed (status ${res.status}): ${JSON.stringify(res.body)}`,
    );
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
) {
  const res = await request(app)
    .post(`/api/organizations/${organizationId}/issues`)
    .set("Cookie", [cookie])
    .send({ title, projectId });
  return res.body;
}

describe("cursor pagination — issues list", () => {
  it("pages through all rows with no gaps or duplicates, and reports hasNextPage correctly", async () => {
    const cookie = await signupAndLogin("pagination-user@example.com");
    const orgId = await createOrg(cookie, "Pagination Org");
    const projectId = await createProject(cookie, orgId, "Pagination Project");

    const created: string[] = [];
    for (let i = 0; i < 12; i++) {
      const issue = await createIssue(cookie, orgId, projectId, `Issue ${i}`);
      created.push(issue.id);
    }

    const seenIds = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;

    do {
      const res: Response = await request(app)
        .get(`/api/organizations/${orgId}/issues`)
        .query({ limit: 5, ...(cursor ? { cursor } : {}) })
        .set("Cookie", [cookie]);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeLessThanOrEqual(5);

      for (const issue of res.body.data) {
        expect(seenIds.has(issue.id)).toBe(false);
        seenIds.add(issue.id);
      }

      expect(res.body.hasNextPage).toBe(Boolean(res.body.nextCursor));

      cursor = res.body.nextCursor;
      pageCount++;
      expect(pageCount).toBeLessThan(10);
    } while (cursor);

    expect(seenIds.size).toBe(12);
    for (const id of created) {
      expect(seenIds.has(id)).toBe(true);
    }
  });

  it("validates query params: default limit, max limit, and malformed cursor", async () => {
    const cookie = await signupAndLogin("pagination-validation@example.com");
    const orgId = await createOrg(cookie, "Validation Org");

    const defaultRes = await request(app)
      .get(`/api/organizations/${orgId}/issues`)
      .set("Cookie", [cookie]);
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.body.data).toEqual([]);
    expect(defaultRes.body.hasNextPage).toBe(false);
    expect(defaultRes.body.nextCursor).toBeNull();

    const overLimitRes = await request(app)
      .get(`/api/organizations/${orgId}/issues`)
      .query({ limit: 999 })
      .set("Cookie", [cookie]);
    expect(overLimitRes.status).toBe(400);

    const badCursorRes = await request(app)
      .get(`/api/organizations/${orgId}/issues`)
      .query({ cursor: "not-valid-base64-json!!" })
      .set("Cookie", [cookie]);
    expect(badCursorRes.status).toBe(400);
  });

  it("does not leak another organization's rows, including across a replayed cursor", async () => {
    const cookieA = await signupAndLogin("tenant-a@example.com");
    const cookieB = await signupAndLogin("tenant-b@example.com");

    const orgA = await createOrg(cookieA, "Org A");
    const orgB = await createOrg(cookieB, "Org B");

    const projectA = await createProject(cookieA, orgA, "Project A");
    const projectB = await createProject(cookieB, orgB, "Project B");

    for (let i = 0; i < 3; i++) {
      await createIssue(cookieA, orgA, projectA, `Org A Issue ${i}`);
    }
    for (let i = 0; i < 3; i++) {
      await createIssue(cookieB, orgB, projectB, `Org B Issue ${i}`);
    }

    const pageA = await request(app)
      .get(`/api/organizations/${orgA}/issues`)
      .query({ limit: 1 })
      .set("Cookie", [cookieA]);

    expect(pageA.body.nextCursor).toBeTruthy();

    const crossOrgAttempt = await request(app)
      .get(`/api/organizations/${orgB}/issues`)
      .query({ limit: 10, cursor: pageA.body.nextCursor })
      .set("Cookie", [cookieA]);

    expect(crossOrgAttempt.status).toBe(403);

    const pageB = await request(app)
      .get(`/api/organizations/${orgB}/issues`)
      .query({ limit: 10 })
      .set("Cookie", [cookieB]);

    const leaked = pageB.body.data.filter((i: { title: string }) =>
      i.title.startsWith("Org A"),
    );
    expect(leaked.length).toBe(0);
  });
});
