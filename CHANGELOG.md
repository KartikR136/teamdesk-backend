# Changelog

## Unreleased — Developer Home Dashboard

### Added
- `GET /api/dashboard/home` — single aggregated endpoint for the developer
  home dashboard. Response shape matches the frontend's
  `DashboardHomeResponse` (frontend repo: `src/mock/dashboard.ts`)
  field-for-field. See `docs/DASHBOARD.md`.
- `src/modules/dashboard/` — clean-architecture module (controller,
  service, repository, dto, routes, providers).
- Provider interfaces + mock implementations for future GitHub/GitLab/
  Bitbucket (PRs), Vercel/Render/Railway/AWS (deployments), CI (build
  health), and Google Calendar/Outlook (meetings) integrations.
- `ActivityLogCodingStatsProvider` — real `currentStreakDays` and
  `issuesCompletedThisWeek`, derived from existing `ActivityLog`/`Issue`
  data; `reviewsCompletedThisWeek`/`commitsThisWeek`/`focusHoursThisWeek`
  honestly zeroed pending PR-review/VCS/time-tracking integrations.
- `DashboardSummaryService` — templated `{ headline, bullets, generatedAt }`
  summary generated from real dashboard data (no LLM call).
- `Notification` model (with `actorId` for the frontend's `actorName`
  field) + `notify()`/`notifyMany()` helper (`src/lib/notifications.ts`),
  hooked into issue assignment/status-change, comment creation, and
  member-joined events.
- `RecentlyViewedIssue` model, updated on every `GET /issues/:issueId`,
  capped at 10 per user.
- `Issue.dueDate` and `Issue.estimatePoints` (both nullable) — required by
  the assigned-tasks section, didn't exist before. Now settable via
  `POST /organizations/:id/issues` and `PATCH /issues/:id`.
- New indexes: `Issue(organizationId, createdAt)`, `Issue(assigneeId,
  dueDate)`, `Notification(recipientId, createdAt)`,
  `Notification(organizationId)`, `RecentlyViewedIssue(userId, issueId)`
  unique, `RecentlyViewedIssue(userId, viewedAt)`, plus
  `ActivityLog(organizationId, createdAt)` and
  `DecisionLog(organizationId, createdAt)` (matching their existing,
  confirmed query patterns).
- `src/test/dashboard.test.ts` — auth, org-isolation, sorting, progress
  calculation, notification (incl. actor name), recently-viewed, and
  coding-stats coverage.
- Migration `20260718060000_add_dashboard_support`.

### Changed
- `GET /issues/:issueId` — records a recently-viewed entry as a
  fire-and-forget side effect. Response body unchanged.
- `PATCH /issues/:issueId` — now accepts optional `priority`, `dueDate`,
  `estimatePoints`; creates `ISSUE_ASSIGNED`/status-change notifications as
  a side effect when applicable. Previously-existing fields and response
  body unchanged.
- `POST /organizations/:id/issues` — accepts the same three optional
  fields on creation.
- `POST /issues/:issueId/comments` — creates comment notifications for the
  issue's assignee/creator (excluding the comment's own author). Response
  body unchanged.
- `POST /invitations/:invitationId/accept` — notifies existing org admins
  of the new member. Response body unchanged.
- `src/test/setup.ts` — added `notification`/`recentlyViewedIssue` to the
  per-test table truncation, in FK-safe order.

### Not changed
- No existing route path, response shape, or status code.
- No existing authentication/authorization behavior.
- No frontend changes required — `getMockDashboardData()` can be replaced
  with a real fetch of `GET /api/dashboard/home` as a drop-in swap.
