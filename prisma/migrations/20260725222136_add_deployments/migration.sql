-- CreateEnum
CREATE TYPE "DeployEnvironment" AS ENUM ('PRODUCTION', 'PREVIEW', 'STAGING', 'DEVELOPMENT');

-- CreateEnum
CREATE TYPE "DeployStatus" AS ENUM ('QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "DeployHealth" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'DEPLOYMENT_SUCCEEDED';
ALTER TYPE "NotificationType" ADD VALUE 'DEPLOYMENT_FAILED';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "deploymentId" TEXT;

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "environment" "DeployEnvironment" NOT NULL DEFAULT 'PRODUCTION',
    "status" "DeployStatus" NOT NULL DEFAULT 'QUEUED',
    "health" "DeployHealth" NOT NULL DEFAULT 'UNKNOWN',
    "commitHash" TEXT NOT NULL,
    "commitMessage" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "durationSeconds" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "healthCheckedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "pullRequestId" TEXT,
    "triggeredById" TEXT NOT NULL,
    "rolledBackById" TEXT,
    "previousDeploymentId" TEXT,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Deployment_organizationId_createdAt_idx" ON "Deployment"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Deployment_organizationId_environment_createdAt_idx" ON "Deployment"("organizationId", "environment", "createdAt");

-- CreateIndex
CREATE INDEX "Deployment_projectId_idx" ON "Deployment"("projectId");

-- CreateIndex
CREATE INDEX "Deployment_status_idx" ON "Deployment"("status");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_previousDeploymentId_fkey" FOREIGN KEY ("previousDeploymentId") REFERENCES "Deployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_rolledBackById_fkey" FOREIGN KEY ("rolledBackById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
