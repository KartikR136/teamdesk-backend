import { prisma } from "../../../../lib/prisma";
import { DeploymentProvider } from "./DeploymentProvider";
import { ProviderResult } from "../pullRequest/PullRequestProvider";
import {
  DeploymentDto,
  DeployEnvironment,
  DeployStatus,
} from "../../dto/dashboard.dto";

const ENVIRONMENT_MAP: Record<string, DeployEnvironment> = {
  PRODUCTION: "production",
  PREVIEW: "preview",
  STAGING: "staging",
  DEVELOPMENT: "development",
};

// Frontend's DeployStatus union only has three values (no ROLLED_BACK/
// QUEUED) — same "map onto the closest existing value" compromise
// dashboard.dto.ts's NotificationKind comment already documents for PRs.
// ROLLED_BACK renders as "failed" (red, since the original deploy did
// fail — that's *why* it got rolled back) and QUEUED renders as
// "in_progress" (the widget's spinner state) since nothing meaningfully
// different needs to render for "not started yet" on a 5-item feed.
const STATUS_MAP: Record<string, DeployStatus> = {
  QUEUED: "in_progress",
  IN_PROGRESS: "in_progress",
  SUCCESS: "success",
  FAILED: "failed",
  ROLLED_BACK: "failed",
};

// Replaces MockDeploymentProvider now that deployment tracking is a
// first-class, native feature (see prisma schema's Deployment model and
// routes/deployments.ts) rather than a placeholder for a future Vercel/
// Render/Railway webhook integration. `integrationRequired` is always
// false here — same reasoning as NativePullRequestProvider. A real CI/CD
// provider could still be added later as an additional source merged
// alongside this one.
export class NativeDeploymentProvider implements DeploymentProvider {
  readonly name = "native";

  async getRecentDeployments(
    userId: string,
  ): Promise<ProviderResult<DeploymentDto>> {
    const memberships = await prisma.membership.findMany({
      where: { userId },
      select: { organizationId: true },
    });
    const orgIds = memberships.map((m) => m.organizationId);
    if (orgIds.length === 0) {
      return { integrationRequired: false, data: [] };
    }

    const deployments = await prisma.deployment.findMany({
      where: { organizationId: { in: orgIds } },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        organization: { select: { id: true, name: true } },
        project: { select: { id: true, name: true } },
        triggeredBy: { select: { name: true } },
      },
    });

    const data: DeploymentDto[] = deployments.map((d) => ({
      id: d.id,
      environment: ENVIRONMENT_MAP[d.environment] ?? "development",
      status: STATUS_MAP[d.status] ?? "in_progress",
      commitHash: d.commitHash.slice(0, 7),
      commitMessage: d.commitMessage,
      durationSeconds: d.durationSeconds ?? 0,
      triggeredBy: d.triggeredBy.name,
      deployedAt: (d.completedAt ?? d.createdAt).toISOString(),
      organizationId: d.organizationId,
      organizationName: d.organization.name,
      projectId: d.projectId,
      projectName: d.project?.name ?? null,
      health: d.health,
      rolledBack: d.status === "ROLLED_BACK",
      url: `/dashboard/deployments/${d.id}`,
    }));

    return { integrationRequired: false, data };
  }
}
