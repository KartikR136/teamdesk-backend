-- CreateEnum
CREATE TYPE "BuildProvider" AS ENUM ('GITHUB_ACTIONS', 'CIRCLECI', 'GITLAB_CI', 'BUILDKITE', 'JENKINS', 'NATIVE');

-- CreateEnum
CREATE TYPE "BuildRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'PASSING', 'FAILING', 'CANCELLED');

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "buildRunId" TEXT;

-- CreateTable
CREATE TABLE "BuildPipeline" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "BuildProvider" NOT NULL DEFAULT 'NATIVE',
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "webhookToken" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "BuildPipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildRun" (
    "id" TEXT NOT NULL,
    "buildNumber" INTEGER NOT NULL,
    "status" "BuildRunStatus" NOT NULL DEFAULT 'QUEUED',
    "branch" TEXT NOT NULL DEFAULT 'main',
    "commitHash" TEXT NOT NULL,
    "commitMessage" TEXT,
    "testsPassing" INTEGER NOT NULL DEFAULT 0,
    "testsFailing" INTEGER NOT NULL DEFAULT 0,
    "testsSkipped" INTEGER NOT NULL DEFAULT 0,
    "coveragePercent" DOUBLE PRECISION,
    "durationSeconds" INTEGER,
    "flakyTestNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failureSummary" TEXT,
    "logsUrl" TEXT,
    "source" TEXT NOT NULL DEFAULT 'native',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "pipelineId" TEXT NOT NULL,
    "pullRequestId" TEXT,
    "triggeredById" TEXT,

    CONSTRAINT "BuildRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BuildPipeline_webhookToken_key" ON "BuildPipeline"("webhookToken");

-- CreateIndex
CREATE INDEX "BuildPipeline_organizationId_idx" ON "BuildPipeline"("organizationId");

-- CreateIndex
CREATE INDEX "BuildPipeline_projectId_idx" ON "BuildPipeline"("projectId");

-- CreateIndex
CREATE INDEX "BuildRun_organizationId_createdAt_idx" ON "BuildRun"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "BuildRun_pipelineId_createdAt_idx" ON "BuildRun"("pipelineId", "createdAt");

-- CreateIndex
CREATE INDEX "BuildRun_organizationId_branch_createdAt_idx" ON "BuildRun"("organizationId", "branch", "createdAt");

-- CreateIndex
CREATE INDEX "BuildRun_status_idx" ON "BuildRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BuildRun_pipelineId_buildNumber_key" ON "BuildRun"("pipelineId", "buildNumber");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_buildRunId_fkey" FOREIGN KEY ("buildRunId") REFERENCES "BuildRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildPipeline" ADD CONSTRAINT "BuildPipeline_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildPipeline" ADD CONSTRAINT "BuildPipeline_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildPipeline" ADD CONSTRAINT "BuildPipeline_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildRun" ADD CONSTRAINT "BuildRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildRun" ADD CONSTRAINT "BuildRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildRun" ADD CONSTRAINT "BuildRun_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "BuildPipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildRun" ADD CONSTRAINT "BuildRun_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildRun" ADD CONSTRAINT "BuildRun_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
