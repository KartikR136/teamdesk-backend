import { DeploymentProvider } from "./DeploymentProvider";
import { DeploymentDto } from "../../dto/dashboard.dto";
import { ProviderResult } from "../pullRequest/PullRequestProvider";

// One mock class parameterized by provider name rather than four near-
// identical classes (Vercel/Render/Railway/AWS) — each real implementation
// later will differ in actual API calls/auth, at which point it earns its
// own file; today they'd be four copies of the same "not connected" stub.
export class MockDeploymentProvider implements DeploymentProvider {
  constructor(readonly name: string) {}

  async getRecentDeployments(
    _userId: string,
  ): Promise<ProviderResult<DeploymentDto>> {
    return { integrationRequired: true, data: [] };
  }
}
