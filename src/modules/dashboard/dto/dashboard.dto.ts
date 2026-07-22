// Every type in this file is written to match the frontend's
// `DashboardHomeResponse` (frontend repo: src/mock/dashboard.ts) field-for-
// field, so swapping `getMockDashboardData()` for a real fetch of
// `GET /api/dashboard/home` requires zero frontend changes. If you change
// a field here, check that file first — the frontend team owns that type
// as the source of truth for the wire contract, this file mirrors it.

export type IssueStatus = "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";
export type IssuePriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export interface AssignedTaskDto {
  id: string;
  title: string;
  projectName: string;
  status: IssueStatus;
  priority: IssuePriority;
  dueDate: string | null;
  estimatePoints: number | null;
  progress: number; // 0-100
}

// Frontend's NotificationKind is a fixed 6-value union. Our own domain
// model (see src/lib/notifications.ts) tracks a slightly different set of
// event types — some 1:1 (ASSIGNMENT -> ISSUE_ASSIGNED, COMMENT ->
// COMMENT_ADDED, MENTION -> MENTIONED), and two (STATUS_CHANGE, ORG_EVENT)
// that don't have a matching frontend kind yet. Real, human-readable text
// always lives in `message` regardless of `kind` — `kind` only selects an
// icon/color in the UI — so mapping those two to the closest existing kind
// is a cosmetic compromise, not a loss of information.
//
// Flagging as a candidate for a tiny, additive frontend change: adding
// "STATUS_CHANGED" and "ORG_EVENT" to NotificationKind (with a default
// icon) would remove the need for this compromise entirely.
export type NotificationKind =
  | "ISSUE_ASSIGNED"
  | "COMMENT_ADDED"
  | "DECISION_APPROVED"
  | "MENTIONED"
  | "DEPLOYMENT_COMPLETED"
  | "PR_MERGED";

export interface DashboardNotificationDto {
  id: string;
  kind: NotificationKind;
  actorName: string;
  message: string;
  createdAt: string;
  read: boolean;
  groupCount?: number;
}

export type PRReviewUrgency = "low" | "medium" | "high";

export interface PullRequestDto {
  id: string;
  repo: string;
  branch: string;
  title: string;
  author: string;
  openedAt: string;
  filesChanged: number;
  mergeStatus: "clean" | "conflicts" | "checks_failing";
  urgency: PRReviewUrgency;
  url: string;
}

export type DeployEnvironment =
  | "production"
  | "preview"
  | "staging"
  | "development";
export type DeployStatus = "success" | "failed" | "in_progress";

export interface DeploymentDto {
  id: string;
  environment: DeployEnvironment;
  status: DeployStatus;
  commitHash: string;
  commitMessage: string;
  durationSeconds: number;
  triggeredBy: string;
  deployedAt: string;
}

export interface BuildHealthDto {
  pipelineStatus: "passing" | "failing" | "running";
  latestBuildNumber: number;
  coveragePercent: number;
  testsPassing: number;
  testsFailing: number;
  avgBuildDurationSeconds: number;
  lastUpdated: string;
}

export type MeetingKind =
  | "STANDUP"
  | "SPRINT_PLANNING"
  | "DESIGN_REVIEW"
  | "BACKEND_SYNC"
  | "DEMO"
  | "RETROSPECTIVE";

export interface MeetingDto {
  id: string;
  kind: MeetingKind;
  title: string;
  startsAt: string;
  durationMinutes: number;
  attendeeCount: number;
}

export interface RecentlyViewedIssueDto {
  id: string;
  title: string;
  projectName: string;
  priority: IssuePriority;
  status: IssueStatus;
  lastViewedAt: string;
}

export interface CodingStatsDto {
  currentStreakDays: number;
  issuesCompletedThisWeek: number;
  reviewsCompletedThisWeek: number;
  commitsThisWeek: number;
  focusHoursThisWeek: number;
}

export interface AISummaryDto {
  headline: string;
  bullets: string[];
  generatedAt: string;
}

export interface QuickActionDto {
  id: string;
  label: string;
  shortcut: string;
  href: string;
}

export interface DashboardHomeDto {
  aiSummary: AISummaryDto;
  assignedTasks: AssignedTaskDto[];
  notifications: DashboardNotificationDto[];
  pullRequests: PullRequestDto[];
  deployments: DeploymentDto[];
  buildHealth: BuildHealthDto;
  meetings: MeetingDto[];
  recentIssues: RecentlyViewedIssueDto[];
  codingStats: CodingStatsDto;
  quickActions: QuickActionDto[];
}
