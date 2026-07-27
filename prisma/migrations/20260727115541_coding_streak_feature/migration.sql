/*
  Warnings:

  - A unique constraint covering the columns `[codingWebhookToken]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - The required column `codingWebhookToken` was added to the `User` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "codingWebhookToken" TEXT,
ADD COLUMN     "lastFreezeRefillAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "longestStreakDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "streakFreezesAvailable" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "weeklyCommitGoal" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "weeklyIssueGoal" INTEGER NOT NULL DEFAULT 5;

-- Backfill existing rows with a real random token each before enforcing NOT NULL
UPDATE "User" SET "codingWebhookToken" = gen_random_uuid()::text WHERE "codingWebhookToken" IS NULL;

ALTER TABLE "User" ALTER COLUMN "codingWebhookToken" SET NOT NULL;

-- CreateTable
CREATE TABLE "GitCommit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "sha" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "branch" TEXT,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "committedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitCommit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CodingAchievement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "unlockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "CodingAchievement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StreakFreezeUse" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "coveredDate" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StreakFreezeUse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FocusSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "note" TEXT,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FocusSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GitCommit_userId_committedAt_idx" ON "GitCommit"("userId", "committedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GitCommit_userId_sha_key" ON "GitCommit"("userId", "sha");

-- CreateIndex
CREATE INDEX "CodingAchievement_userId_idx" ON "CodingAchievement"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StreakFreezeUse_userId_coveredDate_key" ON "StreakFreezeUse"("userId", "coveredDate");

-- CreateIndex
CREATE INDEX "FocusSession_userId_loggedAt_idx" ON "FocusSession"("userId", "loggedAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_codingWebhookToken_key" ON "User"("codingWebhookToken");

-- AddForeignKey
ALTER TABLE "GitCommit" ADD CONSTRAINT "GitCommit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GitCommit" ADD CONSTRAINT "GitCommit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CodingAchievement" ADD CONSTRAINT "CodingAchievement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StreakFreezeUse" ADD CONSTRAINT "StreakFreezeUse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FocusSession" ADD CONSTRAINT "FocusSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
