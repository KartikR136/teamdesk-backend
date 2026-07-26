import { Router } from "express";
import { requireAuth } from "../../../middleware/requireAuth";
import { DashboardController } from "../controller/dashboard.controller";
import { DashboardService } from "../service/dashboard.service";
import { DashboardRepository } from "../repository/dashboard.repository";
import { NativePullRequestProvider } from "../providers/pullRequest/NativePullRequestProvider";
import { NativeDeploymentProvider } from "../providers/deployment/NativeDeploymentProvider";
import { MockBuildHealthProvider } from "../providers/buildHealth/MockBuildHealthProvider";
import { NativeMeetingCalendarProvider } from "../providers/calendar/NativeMeetingCalendarProvider";
import { ActivityLogCodingStatsProvider } from "../providers/codingStats/ActivityLogCodingStatsProvider";
import { DashboardSummaryService } from "../providers/ai/DashboardSummaryService";

// Composition root for the dashboard module: this is the one place that
// decides which concrete provider implementation backs each interface.
// Swapping a mock for a real integration (e.g. a real GitHub provider once
// OAuth exists) means changing one line here — nothing in the service,
// controller, or repository needs to know or change.
const service = new DashboardService({
  repository: new DashboardRepository(),
  pullRequestProvider: new NativePullRequestProvider(),
  deploymentProvider: new NativeDeploymentProvider(),
  buildHealthProvider: new MockBuildHealthProvider(),
  calendarProvider: new NativeMeetingCalendarProvider(),
  codingStatsProvider: new ActivityLogCodingStatsProvider(),
  summaryService: new DashboardSummaryService(),
});

const controller = new DashboardController(service);

const router = Router();
router.use(requireAuth);

router.get("/home", controller.getHome);

export default router;
