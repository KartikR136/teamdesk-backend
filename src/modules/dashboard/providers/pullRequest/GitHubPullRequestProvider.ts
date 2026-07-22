import { PullRequestProvider, ProviderResult } from "./PullRequestProvider";
import { PullRequestDto } from "../../dto/dashboard.dto";

// Mock implementation: TeamDesk has no GitHub OAuth/App connection flow
// yet, so this always reports integrationRequired (internally) and an
// empty array (on the wire) rather than fabricating pull requests.
// Swapping in a real GitHub client later (Octokit, a GitHub App
// installation token, etc.) means implementing this same interface — the
// dashboard service and route never need to change.
export class GitHubPullRequestProvider implements PullRequestProvider {
  readonly name = "github";

  async getPendingReviews(
    _userId: string,
  ): Promise<ProviderResult<PullRequestDto>> {
    return { integrationRequired: true, data: [] };
  }
}
