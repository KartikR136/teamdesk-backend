import { DeploymentDto } from "../../dto/dashboard.dto";
import { ProviderResult } from "../pullRequest/PullRequestProvider";

// Implemented by mock providers today (Vercel/Render/Railway/AWS all share
// this shape); a real implementation for any of them plugs in without the
// dashboard service changing.
export interface DeploymentProvider {
  readonly name: string;
  getRecentDeployments(userId: string): Promise<ProviderResult<DeploymentDto>>;
}
