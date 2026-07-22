# Developer Home Dashboard

`GET /api/dashboard/home` returns everything a developer needs in one
request. Its response shape is a **1:1 match** for the frontend's own
`DashboardHomeResponse` type (frontend repo: `src/mock/dashboard.ts`) —
that file's `getMockDashboardData()` can be replaced with a real fetch of
this endpoint with **zero frontend changes**.

```
GET /api/dashboard/home
Cookie: accessToken=...

200 OK
{
  "aiSummary":      { "headline": "Today's Focus", "bullets": [ "..." ], "generatedAt": "..." },
  "assignedTasks":  [ { "id", "title", "projectName", "status", "priority", "dueDate", "estimatePoints", "progress" } ],
  "notifications":  [ { "id", "kind", "actorName", "message", "createdAt", "read", "groupCount"? } ],
  "pullRequests":   [ ... ],
  "deployments":    [ ... ],
  "buildHealth":    { "pipelineStatus", "latestBuildNumber", "coveragePercent", ... },
  "meetings":       [ ... ],
  "recentIssues":   [ { "id", "title", "projectName", "priority", "status", "lastViewedAt" } ],
  "codingStats":    { "currentStreakDays", "issuesCompletedThisWeek", "reviewsCompletedThisWeek", "commitsThisWeek", "focusHoursThisWeek" },
  "quickActions":   [ { "id", "label", "shortcut", "href" } ]
}
```

Authentication only (`requireAuth`) — no `requireRole`/org param, because
this view is intentionally **cross-org**: it's a developer's home, not an
org-scoped resource. See "Tenant isolation" below for how that's still
safe.

## Why one endpoint, not nine

A dashboard is read once and shown as a whole, so it's fetched as a whole.
Every section's data source is independent, so they're fetched via
`Promise.all` in `DashboardService.getHome` — total latency is bounded by
the *slowest* section, not the sum of all of them.

## Architecture

```
src/modules/dashboard/
  controller/   — thin HTTP layer (calls service, returns JSON)
  service/      — orchestration: Promise.all across repository + every provider
  repository/   — all Prisma queries for the dashboard's own data (tasks, notifications, recently-viewed)
  dto/          — response shape — kept in exact sync with the frontend's DashboardHomeResponse
  routes/       — Express router + composition root (wires concrete providers to interfaces)
  providers/
    pullRequest/  — PullRequestProvider interface, GitHubPullRequestProvider (mock today)
    deployment/   — DeploymentProvider interface, MockDeploymentProvider
    buildHealth/  — BuildHealthProvider interface, MockBuildHealthProvider (single object, not a list)
    calendar/     — CalendarProvider interface, MockCalendarProvider
    codingStats/  — CodingStatsProvider interface, ActivityLogCodingStatsProvider (partially real, see below)
    ai/           — DashboardSummaryService (templated summary, no LLM call)
```

Each layer only knows about the layer below it through an interface.
Nothing outside `routes/dashboard.routes.ts` (the composition root) knows
which *concrete* provider class is in use.

## Adding a real integration later

Every external-integration section (PRs, deployments, build health,
calendar) is a mock today because TeamDesk has no OAuth/connection flow for
GitHub, Vercel, etc. yet. Internally, each mock still reports
`integrationRequired: true` on a `ProviderResult<T>` — but
`DashboardService` does **not** forward that flag onto the wire, because
the frontend's types have no such field: an empty array/neutral object is
what the frontend's own `EmptyState` components already render correctly
for "nothing here yet."

To add a real integration:

1. Implement the relevant interface (e.g. `PullRequestProvider`) in a new
   class — e.g. `GitLabPullRequestProvider implements PullRequestProvider`.
2. Swap the constructor call in `routes/dashboard.routes.ts`'s composition
   root for the new class.

Nothing in `DashboardService`, `DashboardController`, or the response DTO
needs to change.

## What's real vs. placeholder today

| Section | Status |
|---|---|
| `assignedTasks` | **Real** — TeamDesk's own Issue data |
| `notifications` | **Real** — created at 4 existing mutation points (see below) |
| `recentIssues` | **Real** — tracked on every issue-detail view |
| `codingStats.currentStreakDays` | **Real** — derived from `ActivityLog` |
| `codingStats.issuesCompletedThisWeek` | **Real** — Issues this user completed in the last 7 days |
| `codingStats.reviewsCompletedThisWeek` / `commitsThisWeek` / `focusHoursThisWeek` | **0** — no PR-review/VCS/time-tracking integration exists yet; zeroed, not fabricated |
| `pullRequests`, `deployments`, `meetings` | **Empty array** — no GitHub/Vercel/Calendar integration yet |
| `buildHealth` | **Placeholder object** — no CI integration yet |
| `aiSummary` | **Real, but templated** — generated from the real sections above, no LLM call |
| `quickActions` | **Static** — mirrors the frontend's own hardcoded `QuickActionsCard` list |

The zero/placeholder values above are a direct consequence of the
frontend's fixed numeric/object contract having no "unknown" state — the
most honest value that still satisfies the type. This mirrors the original
spec's "return unknown instead of fake data" instruction as closely as a
strict numeric field allows.

## Notification `kind` mapping (one small, known gap)

Our own domain model (`src/lib/notifications.ts`) tracks: `ASSIGNMENT`,
`COMMENT`, `MENTION`, `STATUS_CHANGE`, `ORG_EVENT`. The frontend's
`NotificationKind` is a fixed 6-value union (`ISSUE_ASSIGNED`,
`COMMENT_ADDED`, `DECISION_APPROVED`, `MENTIONED`, `DEPLOYMENT_COMPLETED`,
`PR_MERGED`) that doesn't have an exact slot for `STATUS_CHANGE` or
`ORG_EVENT`. `dashboard.repository.ts`'s `KIND_MAP` maps both to the
closest existing kind as a **cosmetic-only** compromise — `kind` only
picks an icon/color in the UI; the real human-readable text always lives
in `message` regardless.

**Suggested small, additive frontend follow-up**: add `"STATUS_CHANGED"`
and `"ORG_EVENT"` to `NotificationKind` (with a default icon) to remove
this compromise entirely. Not done here since it's a frontend file this
milestone doesn't touch.

## Tenant isolation

No `organizationId` route param, no `requireRole` gate — that's
intentional. Isolation is enforced one level down, inside
`DashboardRepository`: every query scopes to `organizationId IN (SELECT
organizationId FROM Membership WHERE userId = <requesting user>)` — never
to a client-supplied `organizationId`. `dashboard.test.ts`'s isolation test
confirms a user only ever sees assigned tasks from orgs they're actually a
member of.

## Data model additions

- **`Issue.dueDate`** (nullable `DateTime`) and **`Issue.estimatePoints`**
  (nullable `Int`) — both required by `assignedTasks`, neither existed
  before. Both are also now settable via `POST /organizations/:id/issues`
  and `PATCH /issues/:id` (small, additive, optional request-body fields —
  no existing field or behavior changed).
- **`Issue.progress`** has **no backing column** — it's computed at read
  time from `status` (`TODO`→0%, `IN_PROGRESS`→50%, `IN_REVIEW`→90%,
  `DONE`→100%), documented in `dashboard.repository.ts`, since there's no
  subtask/checklist model to derive real progress from yet.
- **`Notification`** — separate from `ActivityLog` on purpose:
  `ActivityLog` records who performed an action (the actor, for audit);
  `Notification` records who should be told about it (the recipient) —
  frequently a different person — and now also carries `actorId` (who
  caused it), needed for the frontend's `actorName` field. Created via a
  `notify()`/`notifyMany()` helper (`src/lib/notifications.ts`) that
  mirrors `logActivity`'s own fire-and-forget, swallow-your-own-errors
  pattern, at four existing mutation points: issue assignment/status
  change (`PATCH /issues/:id`), comment creation
  (`POST /issues/:id/comments`), and member joining
  (`POST /invitations/:id/accept`).
- **`RecentlyViewedIssue`** — one row per `(user, issue)` pair, upserted on
  every `GET /issues/:issueId`, capped at 10 per user.

See `prisma/migrations/20260718060000_add_dashboard_support/migration.sql`.

> **Note on this migration**: hand-written to match Prisma's SQL
> generation conventions, because this environment has no network access
> to download the Prisma query-engine binary needed to run
> `prisma migrate dev` and generate it automatically. Before applying to a
> real database, run `prisma migrate dev` (or `prisma migrate diff`) in an
> environment with network access to confirm it matches `schema.prisma`
> exactly.

## API contract additions (small, explicitly allowed by the spec)

- `GET /issues/:issueId` — now records a recently-viewed entry as a side
  effect. Response body unchanged.
- `PATCH /issues/:issueId` — now accepts optional `priority`, `dueDate`,
  `estimatePoints` fields (previously only `title`/`description`/`status`/
  `assigneeId`), and creates notifications as a side effect when
  applicable. All previously-existing fields and the response body are
  unchanged.
- `POST /organizations/:id/issues` — now accepts the same three optional
  fields on creation.
- `POST /issues/:issueId/comments` — now creates `COMMENT` notifications.
  Response body unchanged.
- `POST /invitations/:invitationId/accept` — now notifies existing org
  admins of the new member. Response body unchanged.
- No existing route path, response shape, or status code changed.

## Performance

- Every section fetches independently and in parallel (`Promise.all`).
- Assigned tasks use `(assigneeId, dueDate)` and `(organizationId,
  createdAt)` indexes added in this migration.
- Notifications and recently-viewed issues are indexed on
  `(recipientId/userId, createdAt/viewedAt)`.
- `include`/`select` used throughout to avoid N+1s.

## Testing

`src/test/dashboard.test.ts` covers: auth requirement, full response shape
matching the frontend contract on an empty account, org isolation,
priority/due-date sorting, `DONE`-issue exclusion and progress
calculation, notification creation on assignment (and *not* on
self-assignment) including `actorName`, recently-viewed capping/ordering,
and coding-stats' real streak/issues-completed values.
