import { DashboardRepository } from "../repository/dashboard.repository";
import { PullRequestProvider } from "../providers/pullRequest/PullRequestProvider";
import { DeploymentProvider } from "../providers/deployment/DeploymentProvider";
import { BuildHealthProvider } from "../providers/buildHealth/BuildHealthProvider";
import { CalendarProvider } from "../providers/calendar/CalendarProvider";
import { CodingStatsProvider } from "../providers/codingStats/CodingStatsProvider";
import { DashboardSummaryService } from "../providers/ai/DashboardSummaryService";
import { DashboardHomeDto, QuickActionDto } from "../dto/dashboard.dto";

export interface DashboardServiceDeps {
  repository: DashboardRepository;
  pullRequestProvider: PullRequestProvider;
  deploymentProvider: DeploymentProvider;
  buildHealthProvider: BuildHealthProvider;
  calendarProvider: CalendarProvider;
  codingStatsProvider: CodingStatsProvider;
  summaryService: DashboardSummaryService;
}

// Static for now — mirrors the frontend's own QuickActionsCard.tsx, which
// currently hardcodes its actions locally rather than consuming this field
// at all. Kept here anyway for contract completeness (the frontend type
// declares it) and so a future version of that component has real,
// backend-driven hrefs to switch to instead of its own hardcoded list.
const QUICK_ACTIONS: QuickActionDto[] = [
  { id: "qa-1", label: "Create Issue", shortcut: "C I", href: "#" },
  { id: "qa-2", label: "Create Project", shortcut: "C P", href: "#" },
  {
    id: "qa-3",
    label: "Decision Log",
    shortcut: "G D",
    href: "/dashboard/decisions/new",
  },
  {
    id: "qa-4",
    label: "Invite Member",
    shortcut: "G M",
    href: "/dashboard/members",
  },
  { id: "qa-5", label: "Search Issues", shortcut: "⌘K", href: "#" },
];

export class DashboardService {
  constructor(private readonly deps: DashboardServiceDeps) {}

  // Every section's data comes from an independent source (own DB query or
  // own provider call), so they're fetched in parallel via Promise.all
  // rather than sequentially — this is the whole point of the <200ms
  // target. aiSummary is the one exception: it depends on several of the
  // other sections' already-fetched results, so it's computed after the
  // Promise.all resolves rather than needing its own round trip.
  async getHome(userId: string): Promise<DashboardHomeDto> {
    const {
      repository,
      pullRequestProvider,
      deploymentProvider,
      buildHealthProvider,
      calendarProvider,
      codingStatsProvider,
    } = this.deps;

    const [
      assignedTasks,
      pendingReviewsResult,
      deploymentsResult,
      buildHealthResult,
      meetingsResult,
      notifications,
      unreadNotificationCount,
      codingStats,
      recentIssues,
    ] = await Promise.all([
      repository.getAssignedTasks(userId),
      pullRequestProvider.getPendingReviews(userId),
      deploymentProvider.getRecentDeployments(userId),
      buildHealthProvider.getBuildHealth(userId),
      calendarProvider.getTodaysMeetings(userId),
      repository.getNotifications(userId),
      repository.getUnreadNotificationCount(userId),
      codingStatsProvider.getStats(userId),
      repository.getRecentlyViewedIssues(userId),
    ]);

    const aiSummary = this.deps.summaryService.generateSummary({
      assignedTasks,
      unreadNotificationCount,
      recentDeploymentCount: deploymentsResult.data.length,
      pendingReviewCount: pendingReviewsResult.data.length,
    });

    return {
      aiSummary,
      assignedTasks,
      // Providers' `integrationRequired` flag is intentionally not
      // forwarded here — the frontend's types have no such field, and an
      // empty array already renders a correct "nothing here" EmptyState
      // for every one of these cards. See PullRequestProvider.ts's
      // ProviderResult comment for the full reasoning.
      notifications,
      pullRequests: pendingReviewsResult.data,
      deployments: deploymentsResult.data,
      buildHealth: buildHealthResult.data,
      meetings: meetingsResult.data,
      recentIssues,
      codingStats,
      quickActions: QUICK_ACTIONS,
    };
  }
}
