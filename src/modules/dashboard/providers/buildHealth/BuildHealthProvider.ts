import { BuildHealthDto } from "../../dto/dashboard.dto";

// Unlike the array-shaped provider results (PRs, deployments, meetings),
// the frontend's `buildHealth` field is a single object, not a list — one
// pipeline's current health, not a history of failures. Interface shaped
// to match: no `ProviderResult<T>` wrapper, just an object plus its own
// `integrationRequired` flag (which DashboardService also doesn't forward
// to the wire — see PullRequestProvider.ts's ProviderResult comment for
// why).
export interface BuildHealthResult {
  integrationRequired: boolean;
  data: BuildHealthDto;
}

// CI providers (GitHub Actions, CircleCI, Buildkite, ...) all implement
// this same contract.
export interface BuildHealthProvider {
  readonly name: string;
  getBuildHealth(userId: string): Promise<BuildHealthResult>;
}
