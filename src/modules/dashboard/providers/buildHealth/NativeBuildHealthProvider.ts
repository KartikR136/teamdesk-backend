import { prisma } from "../../../../lib/prisma";
import { BuildHealthProvider, BuildHealthResult } from "./BuildHealthProvider";
import { BuildHealthDto } from "../../dto/dashboard.dto";

// Frontend's pipelineStatus union only has three values (no CANCELLED) —
// same "map onto the closest existing value" compromise dashboard.dto.ts's
// NotificationKind/STATUS_MAP comments already document elsewhere.
// CANCELLED renders as "running" (neither clearly good nor bad, and rare
// enough not to warrant its own frontend state) and QUEUED/RUNNING both
// render as "running".
const STATUS_MAP: Record<string, BuildHealthDto["pipelineStatus"]> = {
  QUEUED: "running",
  RUNNING: "running",
  PASSING: "passing",
  FAILING: "failing",
  CANCELLED: "running",
};

// Replaces MockBuildHealthProvider now that build/CI tracking is a
// first-class, native feature (see prisma schema's BuildPipeline/BuildRun
// models and routes/buildPipelines.ts + routes/ciWebhooks.ts) rather than
// a permanent placeholder for a future integration. `integrationRequired`
// reflects reality now: false once the user's orgs have at least one
// build run recorded (whether simulated or ingested from a real CI
// webhook), true if no pipeline has reported anything yet — mirrors the
// "empty array = not connected" convention NativeDeploymentProvider and
// NativePullRequestProvider use, just expressed for a single-object
// result instead of a list.
export class NativeBuildHealthProvider implements BuildHealthProvider {
  readonly name = "native";

  async getBuildHealth(userId: string): Promise<BuildHealthResult> {
    const memberships = await prisma.membership.findMany({
      where: { userId },
      select: { organizationId: true },
    });
    const orgIds = memberships.map((m) => m.organizationId);

    const latestRun = orgIds.length
      ? await prisma.buildRun.findFirst({
          where: { organizationId: { in: orgIds } },
          orderBy: { createdAt: "desc" },
        })
      : null;

    if (!latestRun) {
      return {
        integrationRequired: true,
        data: {
          pipelineStatus: "passing",
          latestBuildNumber: 0,
          coveragePercent: 0,
          testsPassing: 0,
          testsFailing: 0,
          avgBuildDurationSeconds: 0,
          lastUpdated: new Date().toISOString(),
        },
      };
    }

    // Average build duration over the last 20 runs across the user's
    // orgs — a single latest run's duration is noisy; a short rolling
    // window is a much more stable "typical build time" than either one
    // run or the entire history.
    const recentRuns = await prisma.buildRun.findMany({
      where: { organizationId: { in: orgIds }, durationSeconds: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { durationSeconds: true },
    });
    const avgBuildDurationSeconds = recentRuns.length
      ? Math.round(
          recentRuns.reduce((sum, r) => sum + (r.durationSeconds ?? 0), 0) /
            recentRuns.length,
        )
      : (latestRun.durationSeconds ?? 0);

    const data: BuildHealthDto = {
      pipelineStatus: STATUS_MAP[latestRun.status] ?? "running",
      latestBuildNumber: latestRun.buildNumber,
      coveragePercent: Math.round(latestRun.coveragePercent ?? 0),
      testsPassing: latestRun.testsPassing,
      testsFailing: latestRun.testsFailing,
      avgBuildDurationSeconds,
      lastUpdated: (latestRun.completedAt ?? latestRun.createdAt).toISOString(),
    };

    return { integrationRequired: false, data };
  }
}
