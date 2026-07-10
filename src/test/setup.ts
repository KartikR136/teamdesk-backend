import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";

beforeEach(async () => {
  // Order matters: delete children before parents to satisfy FK constraints.
  await prisma.activityLog.deleteMany();
  await prisma.comment.deleteMany();
  await prisma.issue.deleteMany();
  await prisma.project.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});
