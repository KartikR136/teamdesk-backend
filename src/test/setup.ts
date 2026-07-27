import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";

beforeEach(async () => {
  // Order matters: delete children before parents to satisfy FK constraints.
  await prisma.notification.deleteMany();
  await prisma.recentlyViewedIssue.deleteMany();
  await prisma.activityLog.deleteMany();
  await prisma.decisionRelatedIssue.deleteMany();
  await prisma.decisionLog.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.issue.deleteMany();
  await prisma.project.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  // Guard: EmailVerificationToken was added in a recent migration.
  // If the migration hasn't been applied yet (e.g. a fresh test DB),
  // skip this cleanup rather than crashing every unrelated test suite.
  // Fix: run `npx prisma migrate deploy` (or `npx prisma db push`) so the
  // table actually exists, then this try/catch becomes a no-op.
  try {
    await prisma.emailVerificationToken.deleteMany();
  } catch (err: any) {
    if (!err?.message?.includes("does not exist")) throw err;
  }
  await prisma.membership.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});
