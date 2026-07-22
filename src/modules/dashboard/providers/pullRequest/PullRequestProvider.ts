import { PullRequestDto } from "../../dto/dashboard.dto";

// A provider either has a working integration for this user and returns
// real data, or it doesn't and returns an empty array — the frontend's
// PullRequestsCard already renders a clean "no open reviews" EmptyState
// for an empty array, so there's no need for a separate "not connected"
// signal on the wire. (Internally, ProviderResult below still carries
// `integrationRequired` for observability/logging and for any future
// consumer that does want to distinguish the two — DashboardService just
// doesn't forward it into the frontend-facing response.)
export interface ProviderResult<T> {
  integrationRequired: boolean;
  data: T[];
}

// Implemented by GitHubPullRequestProvider today; GitLab/Bitbucket
// implementations plug in later by satisfying this same contract — nothing
// in the dashboard service needs to change when they're added.
export interface PullRequestProvider {
  readonly name: string;
  getPendingReviews(userId: string): Promise<ProviderResult<PullRequestDto>>;
}
