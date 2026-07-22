// Rate-limit budget tracking (see TESTING.md): this file's 5 tests call
// signupAndLogin a total of 7 times (1 + 2 + 2 + 1 + 1) — each signup is
// one request against the shared 10-req/15-min authLimiter bucket, since
// Jest resets modules (and the limiter's in-memory store) per file, not
// per test. 7 of 10 — a future test added here should account for this
// before adding another signup pair.
import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";
import { extractCookie } from "./testUtils";

// Same shared-authLimiter caveat as comments.test.ts/pagination.test.ts:
// signup+login+refresh share one 10-req/15min bucket. This file uses
// signup-sets-cookies-directly (no separate login call) wherever possible
// to keep each test's request count down.

async function signupAndLogin(email: string): Promise<string> {
  const signupRes = await request(app).post("/api/auth/signup").send({
    email,
    password: "correctpassword",
    name: "Test User",
  });
  const setCookie = signupRes.headers["set-cookie"];
  if (!setCookie) {
    throw new Error(
      `Signup for ${email} returned no set-cookie header (status ${signupRes.status}, ` +
        `body: ${JSON.stringify(signupRes.body)}).`,
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

const VALID_DECISION_BODY = {
  title: "Adopt cursor pagination",
  problemStatement: "Offset pagination degrades as tables grow.",
  context: "All list endpoints currently need pagination.",
  alternatives: "Considered offset pagination and no pagination at all.",
  chosenSolution: "Cursor-based pagination using {createdAt, id}.",
  tradeoffs: "No jump-to-page-N; only forward iteration.",
};

describe("decisions", () => {
  it("full lifecycle: create, list, get, update, change status, delete", async () => {
    const cookie = await signupAndLogin("decisions-user@example.com");
    const orgId = await createOrg(cookie, "Decisions Org");
    const projectId = await createProject(cookie, orgId, "Decisions Project");
    const issueId = await createIssue(
      cookie,
      orgId,
      projectId,
      "Issue referenced by a decision",
    );

    // Missing required fields — should fail validation, not silently
    // create a partial row.
    const invalidRes = await request(app)
      .post(`/api/organizations/${orgId}/decisions`)
      .set("Cookie", [cookie])
      .send({ title: "Incomplete decision" });
    expect(invalidRes.status).toBe(400);

    const createRes = await request(app)
      .post(`/api/organizations/${orgId}/decisions`)
      .set("Cookie", [cookie])
      .send({
        ...VALID_DECISION_BODY,
        projectId,
        relatedIssueIds: [issueId],
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.title).toBe(VALID_DECISION_BODY.title);
    expect(createRes.body.status).toBe("DRAFT");
    expect(createRes.body.author).toBeDefined();
    expect(createRes.body.project.id).toBe(projectId);
    expect(createRes.body.relatedIssues).toHaveLength(1);
    const decisionId = createRes.body.id as string;

    const listRes = await request(app)
      .get(`/api/organizations/${orgId}/decisions`)
      .set("Cookie", [cookie]);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.length).toBe(1);
    expect(listRes.body.data[0].id).toBe(decisionId);

    const getRes = await request(app)
      .get(`/api/decisions/${decisionId}`)
      .set("Cookie", [cookie]);
    expect(getRes.status).toBe(200);
    expect(getRes.body.chosenSolution).toBe(VALID_DECISION_BODY.chosenSolution);

    const updateRes = await request(app)
      .patch(`/api/decisions/${decisionId}`)
      .set("Cookie", [cookie])
      .send({ title: "Adopt cursor pagination (revised)" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.title).toBe("Adopt cursor pagination (revised)");

    const statusRes = await request(app)
      .patch(`/api/decisions/${decisionId}/status`)
      .set("Cookie", [cookie])
      .send({ status: "ACCEPTED" });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe("ACCEPTED");

    // Invalid status value should be rejected, not coerced or ignored.
    const invalidStatusRes = await request(app)
      .patch(`/api/decisions/${decisionId}/status`)
      .set("Cookie", [cookie])
      .send({ status: "NOT_A_REAL_STATUS" });
    expect(invalidStatusRes.status).toBe(400);

    const deleteRes = await request(app)
      .delete(`/api/decisions/${decisionId}`)
      .set("Cookie", [cookie]);
    expect(deleteRes.status).toBe(204);

    const listAfterDelete = await request(app)
      .get(`/api/organizations/${orgId}/decisions`)
      .set("Cookie", [cookie]);
    expect(listAfterDelete.body.data.length).toBe(0);
  });

  it("hostile tenant: blocks a non-member from reading, writing, or resolving another org's decision by ID", async () => {
    const ownerCookie = await signupAndLogin("decisions-owner@example.com");
    const outsiderCookie = await signupAndLogin(
      "decisions-outsider@example.com",
    );

    const orgId = await createOrg(ownerCookie, "Private Decisions Org");

    const createRes = await request(app)
      .post(`/api/organizations/${orgId}/decisions`)
      .set("Cookie", [ownerCookie])
      .send(VALID_DECISION_BODY);
    expect(createRes.status).toBe(201);
    const decisionId = createRes.body.id as string;

    // Outsider has no membership in this org at all — requireRole should
    // reject before any author/admin ownership check is reached.
    const listAttempt = await request(app)
      .get(`/api/organizations/${orgId}/decisions`)
      .set("Cookie", [outsiderCookie]);
    expect(listAttempt.status).toBe(403);

    const createAttempt = await request(app)
      .post(`/api/organizations/${orgId}/decisions`)
      .set("Cookie", [outsiderCookie])
      .send(VALID_DECISION_BODY);
    expect(createAttempt.status).toBe(403);

    // IDOR: outsider guesses/reuses a real decision ID from another org.
    // resolveOrgFromDecision is a resource-derived resolver, so this now
    // correctly returns 404 (not 403) — see requireRole.ts's
    // notFoundIfNoMembership and THREAT_MODEL.md. This mirrors the same
    // fix already proven for Issues in multiTenant.test.ts.
    const getAttempt = await request(app)
      .get(`/api/decisions/${decisionId}`)
      .set("Cookie", [outsiderCookie]);
    expect(getAttempt.status).toBe(404);

    const editAttempt = await request(app)
      .patch(`/api/decisions/${decisionId}`)
      .set("Cookie", [outsiderCookie])
      .send({ title: "Hijacked" });
    expect(editAttempt.status).toBe(404);

    const statusAttempt = await request(app)
      .patch(`/api/decisions/${decisionId}/status`)
      .set("Cookie", [outsiderCookie])
      .send({ status: "ACCEPTED" });
    expect(statusAttempt.status).toBe(404);

    const deleteAttempt = await request(app)
      .delete(`/api/decisions/${decisionId}`)
      .set("Cookie", [outsiderCookie]);
    expect(deleteAttempt.status).toBe(404);
  });

  it("blocks a same-org MEMBER (not the author, not an admin) from editing, changing status, or deleting someone else's decision", async () => {
    // Distinct from the non-member test above: this user has a REAL
    // membership in the same org — the boundary here is the in-app
    // author-or-admin ownership check, not requireRole's membership gate.
    const ownerCookie = await signupAndLogin("decisions-owner2@example.com");
    const orgId = await createOrg(ownerCookie, "Ownership Decisions Org");

    const createRes = await request(app)
      .post(`/api/organizations/${orgId}/decisions`)
      .set("Cookie", [ownerCookie])
      .send(VALID_DECISION_BODY);
    expect(createRes.status).toBe(201);
    const decisionId = createRes.body.id as string;

    // Seeded directly via Prisma membership creation, same pattern
    // comments.test.ts and members.test.ts use, to keep this file's
    // rate-limit budget small.
    const peerSignup = await request(app).post("/api/auth/signup").send({
      email: "decisions-peer@example.com",
      password: "correctpassword",
      name: "Peer User",
    });
    const peerUserId = peerSignup.body.id as string;
    await prisma.membership.create({
      data: { userId: peerUserId, organizationId: orgId, role: "MEMBER" },
    });
    const peerCookie = extractCookie(
      peerSignup.headers["set-cookie"],
      "accessToken",
    );

    const editAttempt = await request(app)
      .patch(`/api/decisions/${decisionId}`)
      .set("Cookie", [peerCookie])
      .send({ title: "Attempted hijack by a real org peer" });
    expect(editAttempt.status).toBe(403);

    const statusAttempt = await request(app)
      .patch(`/api/decisions/${decisionId}/status`)
      .set("Cookie", [peerCookie])
      .send({ status: "ACCEPTED" });
    expect(statusAttempt.status).toBe(403);

    const deleteAttempt = await request(app)
      .delete(`/api/decisions/${decisionId}`)
      .set("Cookie", [peerCookie]);
    expect(deleteAttempt.status).toBe(403);

    // An ADMIN of the same org, however, should be able to override —
    // same moderation rule as comments.ts. The org creator is ADMIN.
    const adminEditAttempt = await request(app)
      .patch(`/api/decisions/${decisionId}`)
      .set("Cookie", [ownerCookie])
      .send({ title: "Edited by admin" });
    expect(adminEditAttempt.status).toBe(200);
  });

  it("cross-org escalation: rejects a projectId or relatedIssueId belonging to a different org", async () => {
    const ownerCookie = await signupAndLogin("decisions-escalate@example.com");
    const orgAId = await createOrg(ownerCookie, "Org A Decisions");
    const orgBId = await createOrg(ownerCookie, "Org B Decisions");

    // Same user is ADMIN of both orgs (creator of each), so requireRole
    // for Org A passes — the real question is whether the route trusts a
    // client-supplied projectId/issueId from Org B without re-verifying
    // it belongs to Org A. Same defense-in-depth pattern issues.ts uses.
    const projectInOrgB = await createProject(ownerCookie, orgBId, "Org B Project");
    const issueInOrgB = await createIssue(
      ownerCookie,
      orgBId,
      projectInOrgB,
      "Org B Issue",
    );

    const badProjectRes = await request(app)
      .post(`/api/organizations/${orgAId}/decisions`)
      .set("Cookie", [ownerCookie])
      .send({ ...VALID_DECISION_BODY, projectId: projectInOrgB });
    expect(badProjectRes.status).toBe(404);

    const badIssueRes = await request(app)
      .post(`/api/organizations/${orgAId}/decisions`)
      .set("Cookie", [ownerCookie])
      .send({ ...VALID_DECISION_BODY, relatedIssueIds: [issueInOrgB] });
    expect(badIssueRes.status).toBe(404);
  });

  it("filters by status via the ?status= query param", async () => {
    const cookie = await signupAndLogin("decisions-filter@example.com");
    const orgId = await createOrg(cookie, "Filter Org");

    const draftRes = await request(app)
      .post(`/api/organizations/${orgId}/decisions`)
      .set("Cookie", [cookie])
      .send({ ...VALID_DECISION_BODY, title: "Draft decision" });
    const acceptedRes = await request(app)
      .post(`/api/organizations/${orgId}/decisions`)
      .set("Cookie", [cookie])
      .send({ ...VALID_DECISION_BODY, title: "Accepted decision" });

    await request(app)
      .patch(`/api/decisions/${acceptedRes.body.id}/status`)
      .set("Cookie", [cookie])
      .send({ status: "ACCEPTED" });

    const filteredRes = await request(app)
      .get(`/api/organizations/${orgId}/decisions?status=ACCEPTED`)
      .set("Cookie", [cookie]);
    expect(filteredRes.status).toBe(200);
    expect(filteredRes.body.data.length).toBe(1);
    expect(filteredRes.body.data[0].id).toBe(acceptedRes.body.id);

    // Invalid filter value is rejected, not silently ignored.
    const invalidFilterRes = await request(app)
      .get(`/api/organizations/${orgId}/decisions?status=NOT_REAL`)
      .set("Cookie", [cookie]);
    expect(invalidFilterRes.status).toBe(400);

    void draftRes; // referenced only to document the fixture, not asserted on directly
  });
});
