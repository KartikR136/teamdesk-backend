import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

// Fixed, predictable password for all demo users — these accounts exist only
// so DEMO_MODE's attack-console scenarios have real data to attack against.
// This seed must never be run against a real production database — see
// THREAT_MODEL.md's residual-risk note for why predictable demo credentials
// are an acceptable trade-off only when DEMO_MODE-gated routes are the sole
// thing exposing them.
const DEMO_PASSWORD = "DemoPassword123!";

// Fixed UUIDs, not slug strings — several routes validate projectId/issueId
// with zod's z.string().uuid(), which rejects non-UUID-shaped strings.
async function seedOrg(opts: {
  slug: string;
  name: string;
  adminEmail: string;
  memberEmail: string;
  projectId: string;
  issueIds: string[];
}) {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const org = await prisma.organization.upsert({
    where: { slug: opts.slug },
    update: {},
    create: { slug: opts.slug, name: opts.name },
  });

  const admin = await prisma.user.upsert({
    where: { email: opts.adminEmail },
    update: {},
    create: {
      email: opts.adminEmail,
      name: `${opts.name} Admin`,
      passwordHash,
    },
  });

  const member = await prisma.user.upsert({
    where: { email: opts.memberEmail },
    update: {},
    create: {
      email: opts.memberEmail,
      name: `${opts.name} Member`,
      passwordHash,
    },
  });

  // Sole ADMIN by design — required by the last-admin-lockout scenario.
  await prisma.membership.upsert({
    where: {
      userId_organizationId: { userId: admin.id, organizationId: org.id },
    },
    update: { role: Role.ADMIN },
    create: { userId: admin.id, organizationId: org.id, role: Role.ADMIN },
  });

  await prisma.membership.upsert({
    where: {
      userId_organizationId: { userId: member.id, organizationId: org.id },
    },
    update: { role: Role.VIEWER },
    create: { userId: member.id, organizationId: org.id, role: Role.VIEWER },
  });

  const project = await prisma.project.upsert({
    where: { id: opts.projectId },
    update: {},
    create: {
      id: opts.projectId,
      name: `${opts.name} Project`,
      organizationId: org.id,
    },
  });

  for (const [i, issueId] of opts.issueIds.entries()) {
    await prisma.issue.upsert({
      where: { id: issueId },
      update: {},
      create: {
        id: issueId,
        title: `${opts.name} Demo Issue ${i + 1}`,
        organizationId: org.id,
        projectId: project.id,
        creatorId: admin.id,
      },
    });
  }

  return { org, admin, member, project };
}

async function main() {
  const orgA = await seedOrg({
    slug: "demo-org-a",
    name: "Demo Org A",
    adminEmail: "admin-a@demo.teamdesk.dev",
    memberEmail: "member-a@demo.teamdesk.dev",
    projectId: "11111111-1111-4111-8111-111111111111",
    // Two issues so a limit=1 page actually yields a nextCursor — needed
    // by the cursor-replay-cross-org scenario.
    issueIds: [
      "11111111-1111-4111-8111-111111111112",
      "11111111-1111-4111-8111-111111111113",
    ],
  });

  const orgB = await seedOrg({
    slug: "demo-org-b",
    name: "Demo Org B",
    adminEmail: "admin-b@demo.teamdesk.dev",
    memberEmail: "member-b@demo.teamdesk.dev",
    projectId: "22222222-2222-4222-8222-222222222221",
    issueIds: ["22222222-2222-4222-8222-222222222222"],
  });

  // Reserved for a future wrong-recipient-invitation-acceptance scenario
  // (M4) — not exercised by any M1 attack scenario yet, seeded now so that
  // milestone doesn't need its own seed changes.
  await prisma.invitation.upsert({
    where: { token: "demo-invitation-token-reserved" },
    update: {},
    create: {
      id: "33333333-3333-4333-8333-333333333333",
      email: "outsider@demo.teamdesk.dev",
      organizationId: orgA.org.id,
      invitedById: orgA.admin.id,
      role: Role.VIEWER,
      token: "demo-invitation-token-reserved",
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7),
    },
  });

  // Demo meetings — gives the "Today's Meetings" widget and /dashboard/
  // meetings something real to show immediately after seeding, without
  // needing a person to create one by hand first.
  const today = new Date();
  const standupToday = new Date(today);
  standupToday.setHours(9, 30, 0, 0);
  const planningToday = new Date(today);
  planningToday.setHours(14, 0, 0, 0);

  await prisma.meeting.upsert({
    where: { id: "44444444-4444-4444-8444-444444444441" },
    update: {},
    create: {
      id: "44444444-4444-4444-8444-444444444441",
      title: "Daily Standup",
      kind: "STANDUP",
      startsAt: standupToday,
      durationMinutes: 15,
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      createdById: orgA.admin.id,
      attendees: {
        create: [
          {
            userId: orgA.admin.id,
            status: "ACCEPTED",
            respondedAt: new Date(),
          },
          { userId: orgA.member.id, status: "INVITED" },
        ],
      },
    },
  });

  await prisma.meeting.upsert({
    where: { id: "44444444-4444-4444-8444-444444444442" },
    update: {},
    create: {
      id: "44444444-4444-4444-8444-444444444442",
      title: "Sprint Planning",
      kind: "SPRINT_PLANNING",
      startsAt: planningToday,
      durationMinutes: 60,
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      createdById: orgA.admin.id,
      attendees: {
        create: [
          {
            userId: orgA.admin.id,
            status: "ACCEPTED",
            respondedAt: new Date(),
          },
          {
            userId: orgA.member.id,
            status: "TENTATIVE",
            respondedAt: new Date(),
          },
        ],
      },
      // Demonstrates the meeting <-> issue link — sprint planning
      // naturally references the demo issues seeded above.
      linkedIssues: {
        create: [{ issueId: "11111111-1111-4111-8111-111111111112" }],
      },
    },
  });

  // Demo pull requests — gives the "Pull Requests Awaiting Review" widget
  // something real to show immediately after seeding, same reasoning as
  // the demo meetings above. One clean PR waiting on the member, one with
  // conflicts and no approvals yet (should surface as "high" urgency),
  // and one already approved by the member (should NOT show up in their
  // "awaiting review" list) — covers the interesting states without
  // needing a person to create PRs by hand first.
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 1000 * 60 * 60 * 50); // >48h -> high urgency
  const sixHoursAgo = new Date(now.getTime() - 1000 * 60 * 60 * 6);

  const prNeedsReview = await prisma.pullRequest.upsert({
    where: { id: "55555555-5555-4555-8555-555555555551" },
    update: {},
    create: {
      id: "55555555-5555-4555-8555-555555555551",
      title: "Add pagination to the issues list",
      description:
        "Cursor-paginates the issues endpoint and updates the list UI to load more on scroll.",
      repoName: "demo-org-a/web",
      sourceBranch: "feat/issue-pagination",
      targetBranch: "main",
      mergeStatus: "CLEAN",
      filesChanged: 6,
      linesAdded: 214,
      linesRemoved: 38,
      createdAt: twoDaysAgo,
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      authorId: orgA.admin.id,
      reviewers: { create: [{ userId: orgA.member.id }] },
      linkedIssues: {
        create: [{ issueId: "11111111-1111-4111-8111-111111111112" }],
      },
    },
  });

  await prisma.pullRequest.upsert({
    where: { id: "55555555-5555-4555-8555-555555555552" },
    update: {},
    create: {
      id: "55555555-5555-4555-8555-555555555552",
      title: "Fix race condition in meeting RSVP upsert",
      description:
        "Two concurrent RSVPs from the same user could both insert instead of upsert. Adds a unique constraint and a transaction.",
      repoName: "demo-org-a/web",
      sourceBranch: "fix/rsvp-race",
      targetBranch: "main",
      mergeStatus: "CONFLICTS",
      filesChanged: 3,
      linesAdded: 41,
      linesRemoved: 9,
      createdAt: sixHoursAgo,
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      authorId: orgA.admin.id,
      reviewers: { create: [{ userId: orgA.member.id }] },
    },
  });

  // Already approved by the member — should be filtered out of their
  // "awaiting review" list by NativePullRequestProvider, demonstrating
  // that an APPROVED review actually clears a PR off the widget.
  await prisma.pullRequest.upsert({
    where: { id: "55555555-5555-4555-8555-555555555553" },
    update: {},
    create: {
      id: "55555555-5555-4555-8555-555555555553",
      title: "Update README with local dev setup",
      repoName: "demo-org-a/web",
      sourceBranch: "docs/dev-setup",
      targetBranch: "main",
      mergeStatus: "CLEAN",
      filesChanged: 1,
      linesAdded: 22,
      linesRemoved: 4,
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      authorId: orgA.admin.id,
      reviewers: {
        create: [
          {
            userId: orgA.member.id,
            status: "APPROVED",
            respondedAt: new Date(),
          },
        ],
      },
    },
  });

  // Demo deployments — gives the "Recent Deployments" dashboard widget
  // and /dashboard/deployments its DORA metrics something real to chart
  // immediately after seeding. Spread across the last ~9 days so
  // deployment-frequency isn't a single-day spike, includes one FAILED
  // prod deploy immediately followed by a SUCCESS (feeds MTTR), and one
  // deploy that later gets superseded by a ROLLED_BACK + new SUCCESS
  // pair (feeds the rollback-lineage UI). commitHash values are chosen
  // so simulateOutcome() in routes/deployments.ts would have produced
  // the SAME status these rows are seeded with, if this had gone through
  // the real endpoint instead of a direct seed — keeps the demo honest
  // rather than hand-picking impossible combinations.
  const daysAgo = (n: number, hour = 10) => {
    const d = new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
    d.setHours(hour, 0, 0, 0);
    return d;
  };

  const deploy1Start = daysAgo(9);
  await prisma.deployment.upsert({
    where: { id: "66666666-6666-4666-8666-666666666661" },
    update: {},
    create: {
      id: "66666666-6666-4666-8666-666666666661",
      environment: "PRODUCTION",
      status: "SUCCESS",
      health: "HEALTHY",
      commitHash: "a1b2c3d4e5f60000000000000000000000000000",
      commitMessage: "Add pagination to the issues list",
      branch: "main",
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      pullRequestId: prNeedsReview.id,
      triggeredById: orgA.admin.id,
      createdAt: deploy1Start,
      startedAt: deploy1Start,
      completedAt: new Date(deploy1Start.getTime() + 210 * 1000),
      durationSeconds: 210,
      healthCheckedAt: new Date(deploy1Start.getTime() + 210 * 1000),
    },
  });

  const deploy2Start = daysAgo(6);
  await prisma.deployment.upsert({
    where: { id: "66666666-6666-4666-8666-666666666662" },
    update: {},
    create: {
      id: "66666666-6666-4666-8666-666666666662",
      environment: "PRODUCTION",
      status: "FAILED",
      health: "UNKNOWN",
      commitHash: "badc0ffee0000000000000000000000000000000",
      commitMessage: "Attempt async cache warming on org switch",
      branch: "main",
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      triggeredById: orgA.admin.id,
      createdAt: deploy2Start,
      startedAt: deploy2Start,
      completedAt: new Date(deploy2Start.getTime() + 45 * 1000),
      durationSeconds: 45,
      notes:
        "Rolled forward with a hotfix rather than rolling back — see next deploy.",
    },
  });

  const deploy3Start = daysAgo(6, 11);
  await prisma.deployment.upsert({
    where: { id: "66666666-6666-4666-8666-666666666663" },
    update: {},
    create: {
      id: "66666666-6666-4666-8666-666666666663",
      environment: "PRODUCTION",
      status: "SUCCESS",
      health: "HEALTHY",
      commitHash: "feedface0000000000000000000000000000000",
      commitMessage: "Hotfix: guard cache warming behind a feature flag",
      branch: "hotfix/cache-warming-guard",
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      triggeredById: orgA.admin.id,
      createdAt: deploy3Start,
      startedAt: deploy3Start,
      completedAt: new Date(deploy3Start.getTime() + 60 * 1000),
      durationSeconds: 60,
      healthCheckedAt: new Date(deploy3Start.getTime() + 60 * 1000),
    },
  });

  // A deploy that later needed a real rollback (not just a hotfix) —
  // demonstrates the rollback lineage UI end to end.
  const deploy4Start = daysAgo(3);
  await prisma.deployment.upsert({
    where: { id: "66666666-6666-4666-8666-666666666664" },
    update: {},
    create: {
      id: "66666666-6666-4666-8666-666666666664",
      environment: "PRODUCTION",
      status: "ROLLED_BACK",
      health: "UNHEALTHY",
      commitHash: "deadbeef0000000000000000000000000000000",
      commitMessage: "Migrate meeting RSVP writes to a new upsert path",
      branch: "fix/rsvp-race",
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      triggeredById: orgA.admin.id,
      createdAt: deploy4Start,
      startedAt: deploy4Start,
      completedAt: new Date(deploy4Start.getTime() + 300 * 1000),
      durationSeconds: 300,
      healthCheckedAt: new Date(deploy4Start.getTime() + 900 * 1000),
      rolledBackAt: new Date(deploy4Start.getTime() + 1200 * 1000),
      rolledBackById: orgA.admin.id,
      notes:
        "Elevated RSVP write latency in production; rolled back rather than debugging live.",
    },
  });

  await prisma.deployment.upsert({
    where: { id: "66666666-6666-4666-8666-666666666665" },
    update: {},
    create: {
      id: "66666666-6666-4666-8666-666666666665",
      environment: "PRODUCTION",
      status: "SUCCESS",
      health: "HEALTHY",
      commitHash: "feedface0000000000000000000000000000000",
      commitMessage:
        "Rollback to fdeface0: Hotfix: guard cache warming behind a feature flag",
      branch: "hotfix/cache-warming-guard",
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      triggeredById: orgA.admin.id,
      previousDeploymentId: "66666666-6666-4666-8666-666666666663",
      createdAt: new Date(deploy4Start.getTime() + 1200 * 1000),
      startedAt: new Date(deploy4Start.getTime() + 1200 * 1000),
      completedAt: new Date(deploy4Start.getTime() + 1220 * 1000),
      durationSeconds: 20,
      healthCheckedAt: new Date(deploy4Start.getTime() + 1220 * 1000),
      notes:
        "Elevated RSVP write latency in production; rolled back rather than debugging live.",
    },
  });

  // Recent, healthy deploy — most recent row for the dashboard widget.
  const deploy6Start = daysAgo(1, 15);
  await prisma.deployment.upsert({
    where: { id: "66666666-6666-4666-8666-666666666666" },
    update: {},
    create: {
      id: "66666666-6666-4666-8666-666666666666",
      environment: "PRODUCTION",
      status: "SUCCESS",
      health: "HEALTHY",
      commitHash: "0ff1ce0000000000000000000000000000000000",
      commitMessage: "Update README with local dev setup",
      branch: "docs/dev-setup",
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      triggeredById: orgA.admin.id,
      createdAt: deploy6Start,
      startedAt: deploy6Start,
      completedAt: new Date(deploy6Start.getTime() + 35 * 1000),
      durationSeconds: 35,
      healthCheckedAt: new Date(deploy6Start.getTime() + 35 * 1000),
    },
  });

  // Staging deploy in a different environment, so the environment tabs
  // on /dashboard/deployments aren't empty for anything but Preview/Dev.
  await prisma.deployment.upsert({
    where: { id: "66666666-6666-4666-8666-666666666667" },
    update: {},
    create: {
      id: "66666666-6666-4666-8666-666666666667",
      environment: "STAGING",
      status: "SUCCESS",
      health: "HEALTHY",
      commitHash: "5ca1ab1e0000000000000000000000000000000",
      commitMessage: "Fix race condition in meeting RSVP upsert",
      branch: "fix/rsvp-race",
      organizationId: orgA.org.id,
      projectId: orgA.project.id,
      triggeredById: orgA.member.id,
      createdAt: daysAgo(4, 9),
      startedAt: daysAgo(4, 9),
      completedAt: new Date(daysAgo(4, 9).getTime() + 40 * 1000),
      durationSeconds: 40,
      healthCheckedAt: new Date(daysAgo(4, 9).getTime() + 40 * 1000),
    },
  });

  console.log("Demo seed complete:", {
    orgA: orgA.org.slug,
    orgB: orgB.org.slug,
    demoPullRequestAwaitingReview: prNeedsReview.title,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
