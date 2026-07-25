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
          { userId: orgA.admin.id, status: "ACCEPTED", respondedAt: new Date() },
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
          { userId: orgA.admin.id, status: "ACCEPTED", respondedAt: new Date() },
          { userId: orgA.member.id, status: "TENTATIVE", respondedAt: new Date() },
        ],
      },
      // Demonstrates the meeting <-> issue link — sprint planning
      // naturally references the demo issues seeded above.
      linkedIssues: {
        create: [{ issueId: "11111111-1111-4111-8111-111111111112" }],
      },
    },
  });

  console.log("Demo seed complete:", {
    orgA: orgA.org.slug,
    orgB: orgB.org.slug,
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
