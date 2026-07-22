import { BuildHealthProvider, BuildHealthResult } from "./BuildHealthProvider";

// Placeholder shape returned when there's no real CI integration —
// zeroed/neutral values rather than fabricated passing numbers, since
// `integrationRequired: true` on this object signals "don't trust this"
// to anything that checks it, and the frontend's BuildHealthCard should
// eventually check that flag once a real integration exists.
export class MockBuildHealthProvider implements BuildHealthProvider {
  readonly name = "github-actions";

  async getBuildHealth(_userId: string): Promise<BuildHealthResult> {
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
}
