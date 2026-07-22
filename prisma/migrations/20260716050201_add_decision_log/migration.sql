-- CreateEnum
CREATE TYPE "DecisionStatus" AS ENUM ('DRAFT', 'ACCEPTED', 'SUPERSEDED', 'ARCHIVED');

-- AlterTable
ALTER TABLE "ActivityLog" ADD COLUMN     "decisionId" TEXT;

-- CreateTable
CREATE TABLE "DecisionLog" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "problemStatement" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "alternatives" TEXT NOT NULL,
    "chosenSolution" TEXT NOT NULL,
    "tradeoffs" TEXT NOT NULL,
    "consequences" TEXT,
    "status" "DecisionStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "projectId" TEXT,

    CONSTRAINT "DecisionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DecisionRelatedIssue" (
    "id" TEXT NOT NULL,
    "decisionId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,

    CONSTRAINT "DecisionRelatedIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DecisionLog_organizationId_idx" ON "DecisionLog"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "DecisionRelatedIssue_decisionId_issueId_key" ON "DecisionRelatedIssue"("decisionId", "issueId");

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "DecisionLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionLog" ADD CONSTRAINT "DecisionLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionLog" ADD CONSTRAINT "DecisionLog_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionLog" ADD CONSTRAINT "DecisionLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionRelatedIssue" ADD CONSTRAINT "DecisionRelatedIssue_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "DecisionLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DecisionRelatedIssue" ADD CONSTRAINT "DecisionRelatedIssue_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
