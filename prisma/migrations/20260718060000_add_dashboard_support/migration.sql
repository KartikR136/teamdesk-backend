-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('MENTION', 'COMMENT', 'ASSIGNMENT', 'STATUS_CHANGE', 'ORG_EVENT');

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN "dueDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN "estimatePoints" INTEGER;

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "message" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipientId" TEXT NOT NULL,
    "actorId" TEXT,
    "organizationId" TEXT NOT NULL,
    "issueId" TEXT,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecentlyViewedIssue" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecentlyViewedIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Issue_organizationId_createdAt_idx" ON "Issue"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Issue_assigneeId_dueDate_idx" ON "Issue"("assigneeId", "dueDate");

-- CreateIndex
CREATE INDEX "Notification_recipientId_createdAt_idx" ON "Notification"("recipientId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_organizationId_idx" ON "Notification"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "RecentlyViewedIssue_userId_issueId_key" ON "RecentlyViewedIssue"("userId", "issueId");

-- CreateIndex
CREATE INDEX "RecentlyViewedIssue_userId_viewedAt_idx" ON "RecentlyViewedIssue"("userId", "viewedAt");

-- CreateIndex
CREATE INDEX "ActivityLog_organizationId_createdAt_idx" ON "ActivityLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "DecisionLog_organizationId_createdAt_idx" ON "DecisionLog"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecentlyViewedIssue" ADD CONSTRAINT "RecentlyViewedIssue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecentlyViewedIssue" ADD CONSTRAINT "RecentlyViewedIssue_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
