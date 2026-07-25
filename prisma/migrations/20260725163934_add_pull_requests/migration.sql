-- CreateEnum
CREATE TYPE "PRStatus" AS ENUM ('OPEN', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PRMergeStatus" AS ENUM ('CLEAN', 'CONFLICTS', 'CHECKS_FAILING');

-- CreateEnum
CREATE TYPE "PRReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PR_REVIEW_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'PR_REVIEW_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'PR_MERGED';

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "pullRequestId" TEXT,
ALTER COLUMN "issueId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "pullRequestId" TEXT;

-- CreateTable
CREATE TABLE "PullRequest" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "repoName" TEXT NOT NULL,
    "sourceBranch" TEXT NOT NULL,
    "targetBranch" TEXT NOT NULL DEFAULT 'main',
    "status" "PRStatus" NOT NULL DEFAULT 'OPEN',
    "mergeStatus" "PRMergeStatus" NOT NULL DEFAULT 'CLEAN',
    "filesChanged" INTEGER NOT NULL DEFAULT 0,
    "linesAdded" INTEGER NOT NULL DEFAULT 0,
    "linesRemoved" INTEGER NOT NULL DEFAULT 0,
    "externalUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "mergedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "authorId" TEXT NOT NULL,

    CONSTRAINT "PullRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequestReviewer" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "PRReviewStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "PullRequestReviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PullRequestLinkedIssue" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PullRequestLinkedIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PullRequest_organizationId_status_idx" ON "PullRequest"("organizationId", "status");

-- CreateIndex
CREATE INDEX "PullRequest_authorId_idx" ON "PullRequest"("authorId");

-- CreateIndex
CREATE INDEX "PullRequest_projectId_idx" ON "PullRequest"("projectId");

-- CreateIndex
CREATE INDEX "PullRequestReviewer_userId_status_idx" ON "PullRequestReviewer"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestReviewer_pullRequestId_userId_key" ON "PullRequestReviewer"("pullRequestId", "userId");

-- CreateIndex
CREATE INDEX "PullRequestLinkedIssue_issueId_idx" ON "PullRequestLinkedIssue"("issueId");

-- CreateIndex
CREATE UNIQUE INDEX "PullRequestLinkedIssue_pullRequestId_issueId_key" ON "PullRequestLinkedIssue"("pullRequestId", "issueId");

-- CreateIndex
CREATE INDEX "Comment_pullRequestId_idx" ON "Comment"("pullRequestId");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequest" ADD CONSTRAINT "PullRequest_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestReviewer" ADD CONSTRAINT "PullRequestReviewer_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestReviewer" ADD CONSTRAINT "PullRequestReviewer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestLinkedIssue" ADD CONSTRAINT "PullRequestLinkedIssue_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PullRequestLinkedIssue" ADD CONSTRAINT "PullRequestLinkedIssue_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
