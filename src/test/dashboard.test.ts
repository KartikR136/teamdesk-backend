import request from "supertest";
import { app } from "../app";
import { prisma } from "../lib/prisma";

// Rate-limit budget note (see TESTING.md): each signupAndGetCookies call is
// one /signup request. Running total in this file: 9 calls against the
// shared 10-req/15-min signupLimiter budget (Jest gives this file its own
// fresh limiter instance — see rateLimiters.ts's module-level state — but
// budget is still shared across all tests *within* this file). Any new
// test added here must keep the total at or under 10, or reuse an
// already-created user instead of signing up a new one.
async function signupAndGetCookies(email: string) {
  const res = await request(app).post("/api/auth/signup").send({
    email,
    password: "password123",
    name: email.split("@")[0],
  });
  return res.headers["set-cookie"];
}

type Cookies = Awaited<ReturnType<typeof signupAndGetCookies>>;

async function createOrg(cookies: Cookies, name: string, slug: string) {
  const res = await request(app)
    .post("/api/organizations")
    .set("Cookie", cookies)
    .send({ name, slug });
  return res.body;
}

async function createProject(cookies: Cookies, orgId: string, name: string) {
  const res = await request(app)
    .post(`/api/organizations/${orgId}/projects`)
    .set("Cookie", cookies)
    .send({ name });
  return res.body;
}

async function createIssue(
  cookies: Cookies,
  orgId: string,
  projectId: string,
  title: string,
) {
  const res = await request(app)
    .post(`/api/organizations/${orgId}/issues`)
    .set("Cookie", cookies)
    .send({ title, projectId });
  return res.body;
}

describe("GET /api/dashboard/home", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/dashboard/home");
    expect(res.status).toBe(401);
  });

  it("returns the full response shape matching the frontend contract for a brand-new user", async () => {
    const cookies = await signupAndGetCookies("dash-empty@example.com");

    const res = await request(app)
      .get("/api/dashboard/home")
      .set("Cookie", cookies);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        assignedTasks: [],
        pullRequests: [],
        deployments: [],
        meetings: [],
        notifications: [],
        recentIssues: [],
        quickActions: expect.any(Array),
        buildHealth: expect.objectContaining({ pipelineStatus: expect.any(String) }),
        codingStats: expect.objectContaining({
          currentStreakDays: 0,
          issuesCompletedThisWeek: 0,
          reviewsCompletedThisWeek: 0,
          commitsThisWeek: 0,
          focusHoursThisWeek: 0,
        }),
        aiSummary: expect.objectContaining({
          headline: expect.any(String),
          bullets: expect.any(Array),
          generatedAt: expect.any(String),
        }),
      }),
    );
    expect(res.body.aiSummary.bullets[0]).toContain("Nothing urgent");
  });

  it("only includes assigned tasks from orgs the user actually belongs to", async () => {
    const cookiesA = await signupAndGetCookies("dash-a@example.com");
    const cookiesB = await signupAndGetCookies("dash-b@example.com");

    const orgA = await createOrg(cookiesA, "Dash Org A", "dash-org-a");
    const project = await createProject(cookiesA, orgA.id, "Project A");
    const issue = await createIssue(cookiesA, orgA.id, project.id, "Fix the bug");

    const userA = await prisma.user.findUnique({
      where: { email: "dash-a@example.com" },
    });
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assigneeId: userA!.id },
    });

    const resA = await request(app)
      .get("/api/dashboard/home")
      .set("Cookie", cookiesA);
    expect(resA.body.assignedTasks).toHaveLength(1);
    expect(resA.body.assignedTasks[0].id).toBe(issue.id);
    expect(resA.body.assignedTasks[0].projectName).toBe("Project A");

    // User B is not a member of Org A — must see nothing.
    const resB = await request(app)
      .get("/api/dashboard/home")
      .set("Cookie", cookiesB);
    expect(resB.body.assignedTasks).toHaveLength(0);
  });

  it("sorts assigned tasks by priority first and nearest due date, excludes DONE issues, and computes progress from status", async () => {
    const cookies = await signupAndGetCookies("dash-sort@example.com");
    const org = await createOrg(cookies, "Sort Org", "sort-org");
    const project = await createProject(cookies, org.id, "Sort Project");
    const user = await prisma.user.findUnique({
      where: { email: "dash-sort@example.com" },
    });

    const low = await createIssue(cookies, org.id, project.id, "Low prio");
    const urgent = await createIssue(cookies, org.id, project.id, "Urgent prio");
    const highSoon = await createIssue(cookies, org.id, project.id, "High, due soon");
    const highLater = await createIssue(cookies, org.id, project.id, "High, due later");
    const done = await createIssue(cookies, org.id, project.id, "Finished task");

    await prisma.issue.update({
      where: { id: low.id },
      data: { assigneeId: user!.id, priority: "LOW" },
    });
    await prisma.issue.update({
      where: { id: urgent.id },
      data: { assigneeId: user!.id, priority: "URGENT" },
    });
    await prisma.issue.update({
      where: { id: highSoon.id },
      data: {
        assigneeId: user!.id,
        priority: "HIGH",
        status: "IN_REVIEW",
        dueDate: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
    });
    await prisma.issue.update({
      where: { id: highLater.id },
      data: {
        assigneeId: user!.id,
        priority: "HIGH",
        dueDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      },
    });
    await prisma.issue.update({
      where: { id: done.id },
      data: { assigneeId: user!.id, status: "DONE" },
    });

    const res = await request(app)
      .get("/api/dashboard/home")
      .set("Cookie", cookies);

    // DONE issue excluded entirely — only 4 of the 5 created issues appear.
    expect(res.body.assignedTasks).toHaveLength(4);

    const titles = res.body.assignedTasks.map((t: { title: string }) => t.title);
    expect(titles).toEqual([
      "Urgent prio",
      "High, due soon",
      "High, due later",
      "Low prio",
    ]);

    // Progress is derived from status (IN_REVIEW -> 90%).
    const highSoonTask = res.body.assignedTasks.find(
      (t: { title: string }) => t.title === "High, due soon",
    );
    expect(highSoonTask.progress).toBe(90);
  });

  it("creates an ISSUE_ASSIGNED notification when an issue is assigned to someone else, and it shows up in their dashboard", async () => {
    const cookiesA = await signupAndGetCookies("dash-notif-a@example.com");
    const cookiesB = await signupAndGetCookies("dash-notif-b@example.com");
    const org = await createOrg(cookiesA, "Notif Org", "notif-org");

    const invite = await request(app)
      .post(`/api/organizations/${org.id}/invitations`)
      .set("Cookie", cookiesA)
      .send({ email: "dash-notif-b@example.com", role: "MEMBER" });
    await request(app)
      .post(`/api/invitations/${invite.body.id}/accept`)
      .set("Cookie", cookiesB);

    const project = await createProject(cookiesA, org.id, "Notif Project");
    const issue = await createIssue(cookiesA, org.id, project.id, "Assign me");
    const userB = await prisma.user.findUnique({
      where: { email: "dash-notif-b@example.com" },
    });

    await request(app)
      .patch(`/api/issues/${issue.id}`)
      .set("Cookie", cookiesA)
      .send({ assigneeId: userB!.id });

    const res = await request(app)
      .get("/api/dashboard/home")
      .set("Cookie", cookiesB);

    expect(res.body.notifications.length).toBeGreaterThanOrEqual(1);
    const assignment = res.body.notifications.find(
      (n: { kind: string }) => n.kind === "ISSUE_ASSIGNED",
    );
    expect(assignment).toBeDefined();
    expect(assignment.read).toBe(false);
    expect(assignment.actorName).toBe("dash-notif-a");
  });

  it("does not notify a user of their own assignment action", async () => {
    const cookies = await signupAndGetCookies("dash-self-assign@example.com");
    const org = await createOrg(cookies, "Self Org", "self-org");
    const project = await createProject(cookies, org.id, "Self Project");
    const issue = await createIssue(cookies, org.id, project.id, "Self assign");
    const user = await prisma.user.findUnique({
      where: { email: "dash-self-assign@example.com" },
    });

    await request(app)
      .patch(`/api/issues/${issue.id}`)
      .set("Cookie", cookies)
      .send({ assigneeId: user!.id });

    const res = await request(app)
      .get("/api/dashboard/home")
      .set("Cookie", cookies);
    expect(
      res.body.notifications.some(
        (n: { kind: string }) => n.kind === "ISSUE_ASSIGNED",
      ),
    ).toBe(false);
  });

  it("tracks recently viewed issues, capped at 10, most recent first", async () => {
    const cookies = await signupAndGetCookies("dash-recent@example.com");
    const org = await createOrg(cookies, "Recent Org", "recent-org");
    const project = await createProject(cookies, org.id, "Recent Project");

    const issues = [];
    for (let i = 0; i < 12; i++) {
      const issue = await createIssue(cookies, org.id, project.id, `Issue ${i}`);
      // Fail fast and clearly if issue creation itself failed (e.g. a
      // transient DB hiccup) — without this, a bad `issue.id` (undefined,
      // or an error body's stray field) surfaces later as a cryptic
      // recordIssueView FK violation instead of a clear assertion here.
      expect(issue).toEqual(expect.objectContaining({ id: expect.any(String) }));
      issues.push(issue);
    }

    for (const issue of issues) {
      const viewRes = await request(app)
        .get(`/api/issues/${issue.id}`)
        .set("Cookie", cookies);
      expect(viewRes.status).toBe(200);
    }

    const res = await request(app)
      .get("/api/dashboard/home")
      .set("Cookie", cookies);

    expect(res.body.recentIssues).toHaveLength(10);
    expect(res.body.recentIssues[0].title).toBe("Issue 11");
    expect(res.body.recentIssues[0].projectName).toBe("Recent Project");
  });

  it("computes coding stats: zero with no activity, real streak once active, real issues-completed count", async () => {
    const cookies = await signupAndGetCookies("dash-stats@example.com");

    // Brand-new user, no org/activity yet — every field should be zero.
    const freshRes = await request(app)
      .get("/api/dashboard/home")
      .set("Cookie", cookies);
    expect(freshRes.body.codingStats.currentStreakDays).toBe(0);
    expect(freshRes.body.codingStats.issuesCompletedThisWeek).toBe(0);

    // Creating an org generates an ActivityLog entry -> real streak.
    const org = await createOrg(cookies, "Stats Org", "stats-org");
    const project = await createProject(cookies, org.id, "Stats Project");

    const activeRes = await request(app)
      .get("/api/dashboard/home")
      .set("Cookie", cookies);
    expect(activeRes.body.codingStats.currentStreakDays).toBeGreaterThanOrEqual(1);

    // Completing an assigned issue this week -> real issues-completed count.
    const user = await prisma.user.findUnique({
      where: { email: "dash-stats@example.com" },
    });
    const issue = await createIssue(cookies, org.id, project.id, "Done this week");
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assigneeId: user!.id, status: "DONE" },
    });

    const completedRes = await request(app)
      .get("/api/dashboard/home")
      .set("Cookie", cookies);
    expect(completedRes.body.codingStats.issuesCompletedThisWeek).toBe(1);
  });
});
