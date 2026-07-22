import { Response } from "express";
import { OrgScopedRequest } from "../../../middleware/requireRole";
import { DashboardService } from "../service/dashboard.service";

export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  // GET /api/dashboard/home
  // Deliberately not org-scoped via resolveOrgFromParam/requireRole the way
  // every other route in this codebase is — this endpoint is intentionally
  // cross-org (a developer's home dashboard spans every organization
  // they're a member of), so the only gate is requireAuth, and tenant
  // isolation is enforced inside DashboardRepository by scoping every query
  // to the requesting user's own memberships, never to a client-supplied
  // organizationId.
  getHome = async (req: OrgScopedRequest, res: Response) => {
    const dashboard = await this.service.getHome(req.userId!);
    res.json(dashboard);
  };
}
