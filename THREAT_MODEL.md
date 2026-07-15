# Threat Model

## Trust boundary

TeamDesk's core invariant is stated in [`ARCHITECTURE.md`](./ARCHITECTURE.md): **no organization can ever access another organization's data.** This document takes the attacker's-eye view of that same invariant.

**The attacker considered here is an authenticated user of Organization A** attempting to access Organization B's data, or to escalate their own role beyond what their real `Membership` grants — not an anonymous internet attacker, and not an infrastructure-level adversary (see Out of Scope below). This is deliberately the harder, more realistic threat: most real breaches of multi-tenant systems come from a legitimate, authenticated user probing the edges of their own access, not from someone with zero credentials.

## Attack vectors

| Vector                                                                                   | Why it's plausible                                                                                                                                                                    | Mechanism that blocks it                                                                                                                                                                                                                                                                                                             | Proven by                                                                                                                                                       | Attack Console                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **IDOR via direct issue ID**                                                             | Issue IDs are UUIDs returned to any authenticated user; guessing or reusing one from another org is the single most common multi-tenant bug class.                                    | `resolveOrgFromIssue` derives `organizationId` from the issue's own DB row, never the client. `requireRole` then checks the requester's `Membership` in _that_ org and denies access if absent. **Currently returns 403**, not the 404 described below — see Residual Risks.                                                         | Backend test suite (cross-org issue access) + Attack Console                                                                                                    | ✅ `idor-cross-org-issue`                                                                 |
| **Cursor replay across orgs**                                                            | Pagination cursors are opaque but not encrypted per-org; a naive implementation might trust a cursor's internal `{createdAt, id}` values without re-checking the org boundary at all. | `requireRole` re-checks membership against the org resolved from the _URL_, independent of anything encoded in the cursor — a cursor minted elsewhere is never sufficient on its own.                                                                                                                                                | Backend test suite (cross-org cursor replay) + Attack Console                                                                                                   | ✅ `cursor-replay-cross-org`                                                              |
| **Client-supplied `organizationId` to escalate access**                                  | The most direct escalation attempt: pass a different org's ID somewhere in the request and hope the server trusts it.                                                                 | Every mutating route re-derives org context server-side (`resolveOrgFromParam`/`resolveOrgFromIssue`/`resolveOrgFromProject`/`resolveOrgFromComment`) and, for issue creation specifically, independently re-verifies the referenced `Project.organizationId` matches — a second, explicit check beyond the route-level org context. | Attack Console (issue-creation variant); backend suite covers the general pattern                                                                               | ✅ `client-supplied-org-escalation`                                                       |
| **Forged/injected role claim in JWT**                                                    | If any code path ever read a role off the token instead of the DB, a validly-signed token with a tampered payload could grant a role the user doesn't have.                           | `AccessTokenPayload` is typed to carry only `userId`. `requireAuth` reads nothing else off the token. `requireRole` always re-queries `Membership.role` (DB or its 60s Redis cache) fresh, every request.                                                                                                                            | Attack Console — signs a **validly-signed** token with an injected `role: "ADMIN"` claim to prove the claim is never read, not just that forged signatures fail | ✅ `forged-role-in-jwt`                                                                   |
| **Role de-sync exploitation** (acting inside the ~60s Redis cache window after demotion) | A named, accepted trade-off in `ARCHITECTURE.md` — worth stating as an attack vector explicitly rather than only as a caching note.                                                   | `invalidateMembershipCache` fires at the three mutation points that cause staleness (role change, removal, invitation acceptance), bounding exposure to a maximum ~60s window rather than leaving it unbounded.                                                                                                                      | Not yet an Attack Console scenario — timing-dependent, hard to demonstrate deterministically in a single request/response. Reserved for M4.                     | ❌ (reserved, M4)                                                                         |
| **Last-admin lockout bypass**                                                            | An org's sole admin removing or demoting themselves would leave the org with no one able to manage membership — a permanent, unrecoverable lockout.                                   | The members route counts remaining `ADMIN` memberships before allowing a removal/demotion and blocks it when the target is the last one.                                                                                                                                                                                             | Backend test suite + Attack Console                                                                                                                             | ✅ `last-admin-lockout`                                                                   |
| **Wrong-recipient invitation acceptance**                                                | An invitation is addressed to an email; a different authenticated user attempting to accept it would let them join an org they were never invited to.                                 | Acceptance requires the authenticated user's email to match `Invitation.email` exactly.                                                                                                                                                                                                                                              | Backend test suite (per `ARCHITECTURE.md`'s mention of wrong-recipient coverage)                                                                                | ❌ (reserved, M4 — seed data exists via `demo-org-a-invitation-1`, no scenario wired yet) |

## Out of scope, named explicitly

- **DDoS / volumetric attacks** — infrastructure-layer, not an application-authorization concern.
- **XSS** — mitigated by React's default escaping and the absence of `dangerouslySetInnerHTML` in this codebase; not re-litigated here.
- **CSRF** — a known, named gap. Cookie-based auth with cross-domain `sameSite: "none"` genuinely removes `sameSite`'s CSRF protection. See `ARCHITECTURE.md`'s Known Trade-offs and `ROADMAP.md` — this is a named "next step for production," not something this document treats as solved.
- **Credential-stuffing / brute-force login** — partially mitigated by the shared rate-limiter bucket across `/login`/`/signup`/`/refresh` (see `ROADMAP.md`'s note that separate buckets are a real, understood next step, not yet built).
- **Infrastructure-level compromise** (a fully compromised Render/Neon/Upstash credential) — out of scope for an application-layer threat model; assumes the hosting layer itself is trusted.

## Residual risk: 403 vs. 404 on resource-derived org context

Discovered while building the Attack Console, not previously documented: `requireRole` returns a uniform 403 ("Not a member of this organization") whenever the authenticated user has no `Membership` in the resolved org — regardless of whether that org was resolved from a URL param (`resolveOrgFromParam`, e.g. `/organizations/:organizationId/...`) or derived from a resource lookup (`resolveOrgFromIssue`/`Project`/`Comment`).

For param-derived routes, 403 is arguably correct — the caller already supplied the org ID, so confirming "you're not a member" reveals nothing new. For resource-derived routes, however, [`API.md`](./API.md) documents a 404 specifically so that probing a resource ID never confirms whether that resource exists in some other org. Right now, an authenticated attacker probing `GET /api/issues/:randomId` _can_ distinguish "the org exists but I'm not in it" (403) from "no such issue anywhere" (404 from `resolveOrgFromIssue` itself when the row genuinely doesn't exist) — a minor information leak relative to the stated design goal, though it does **not** grant access to any data; the core invariant holds either way.

Scoped fix, not yet implemented: give `requireRole` an option (e.g. `notFoundIfNoMembership`), set only by the resource-derived resolvers, so param-derived routes keep today's 403 and resource-derived routes get the 404 API.md promises. Deferred rather than fixed inline here because it touches `requireRole.ts`, shared middleware used by every route file — exactly the kind of change that shouldn't happen without its own scoped commit, per this project's standing architectural-change rule (see `ROADMAP.md`). Good candidate for a small, real cleanup milestone.

## Residual risk: the Attack Console itself

The `/api/_demo/*` routes exist specifically to run real attacks against real seeded data using **predictable, publicly-documented credentials** (`admin-a@demo.teamdesk.dev`, etc.). This is safe on a portfolio deployment where all data is synthetic and disposable, but it would be a genuine liability in any deployment containing real tenant data.

Mitigation: the routes are only mounted at all when `DEMO_MODE=true` at process start (`app.ts`) — not just hidden behind a UI flag. There is no configuration under which these routes exist in a build where `DEMO_MODE` is unset or `false`. Anyone adapting this codebase for real users should treat `DEMO_MODE=true` as permanently disqualifying for a production database, the same way you'd never point a seed script with hardcoded demo passwords at a real customer database.

## Authorization Observability

Every authorization denial produced by `requireAuth` or `requireRole` emits a single structured JSON log entry through `src/lib/logAuthEvent.ts`.

### Current Behavior

The implementation records the following security events:

- `AUTH_DENIED`
- `ROLE_DENIED`

Each log entry includes structured context such as:

- Event type
- Denial reason
- Route/path
- Organization context (when available)
- User identifier (when available)
- User role (when available)
- Reserved `requestId` field for a future correlation-ID implementation

Using structured JSON instead of free-form text makes the logs easier to search, filter, and ingest into log management platforms once the application is deployed.

### Design Decision

This project intentionally uses **structured console logging only** at the current stage.

Persistent storage (database tables) and log aggregation endpoints (for example, `/security-summary`) are deliberately deferred until the deployment environment includes a real logging destination (such as CloudWatch, Datadog, ELK/OpenSearch, Grafana Loki, or another centralized logging solution).

Introducing a durable database table today would create several unanswered operational questions, including:

- Log retention policy
- Database indexing strategy
- Storage growth and cost
- Cleanup and archival processes
- Access control for security logs

Since none of these infrastructure decisions are currently part of the project scope, adding persistent authorization logging now would increase maintenance complexity without providing proportional value.

### Future Evolution

Once production logging infrastructure is available, this implementation can evolve by:

- Forwarding structured events to a centralized log platform
- Using `requestId` to correlate events across services
- Building security dashboards and alerting
- Exposing aggregated operational endpoints (e.g., `/security-summary`)
- Defining retention, indexing, and archival policies appropriate for the deployment environment

## Cross-references

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the invariant and its three reinforcing mechanisms
- [`ROADMAP.md`](./ROADMAP.md) — named-but-deferred production hardening (CSRF, rate-limiter buckets)
- `src/routes/demoAttacks.ts` — the Attack Console's scenario implementations
