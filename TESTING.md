# Testing

This document describes how TeamDesk is actually tested — not an idealized suite, the real one. It was written after an explicit audit (M4) that verified every claim below against the test files themselves, not against what the docs assumed was covered.

## Philosophy: the hostile tenant is a first-class test subject

Most test suites default to testing the happy path and treat authorization as an afterthought — a handful of "should return 403" assertions bolted onto feature tests. TeamDesk inverts that: because the entire product thesis is _"no organization can ever access another organization's data"_ (see `ARCHITECTURE.md`), the test suite treats a **hostile tenant** — an authenticated, legitimate user of one organization deliberately probing the edges of another's — as a named, recurring test persona, not an edge case.

Concretely, this means:

- Every resource-scoped route has at least one test where the attacker is a real, logged-in user with a real account, not an anonymous or malformed request. The interesting failure mode in a multi-tenant system is a legitimate user overreaching, not an unauthenticated stranger.
- Tests assert on the _specific_ boundary that should have caught the attempt (a 403 from `requireRole`'s membership check vs. a 404 from a resource-derived org-context resolver), not just "some error happened."
- Where `ARCHITECTURE.md` names a core invariant, that invariant gets its own direct test — not an inference from other passing tests. M4's audit found and closed one place where this had quietly not happened (forged JWT role claims — see below).

## What's actually tested, by category

| Category                          | Files                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication                    | `auth.test.ts`, `refreshRotation.test.ts`                                                                                                                              |
| Authorization / RBAC              | `rbac.test.ts`, `members.test.ts`                                                                                                                                      |
| Multi-tenancy / hostile tenant    | `multiTenant.test.ts`, `pagination.test.ts` (cursor replay), `comments.test.ts`, `activity.test.ts`, `invitations.test.ts` (wrong recipient), `jwtRoleForgery.test.ts` |
| Authorization caching correctness | `cacheInvalidationMembers.test.ts`, `cacheInvalidationInvitations.test.ts`                                                                                             |
| Pagination                        | `pagination.test.ts`                                                                                                                                                   |
| Validation                        | `validation.test.ts`                                                                                                                                                   |

## The seven scenarios `ARCHITECTURE.md` names, and what's actually verified

M4 checked each of these directly against the test files rather than assuming the docs were accurate:

| Scenario                                               | Verified         | Where                                            |
| ------------------------------------------------------ | ---------------- | ------------------------------------------------ |
| Cross-org cursor replay                                | ✅               | `pagination.test.ts`                             |
| IDOR via guessed cross-org resource ID                 | ✅               | `multiTenant.test.ts`                            |
| Client-supplied cross-org `organizationId`/`projectId` | ✅               | `multiTenant.test.ts`                            |
| Wrong-recipient invitation acceptance                  | ✅               | `invitations.test.ts`                            |
| Last-admin lockout                                     | ✅               | `members.test.ts` (both role-change and removal) |
| Cross-org comment access (non-member)                  | ✅               | `comments.test.ts`                               |
| Forged JWT role claim                                  | ✅ (added in M4) | `jwtRoleForgery.test.ts`                         |

One additional gap the audit found beyond this list: `comments.test.ts` originally only tested a **non-member** being blocked from editing/deleting a comment. It did not test the narrower, same-org case — a legitimate `MEMBER` of the _same_ organization attempting to edit or delete a comment they didn't author and aren't an admin of. That's a distinct code path (an in-app ownership check, not `requireRole`'s membership check), and M4 added a dedicated test for it.

## Testing architecture

- **Runner**: Jest + `ts-jest`. `src/test/setup.ts` truncates every table before each test (in FK-safe order: children before parents) and disconnects Prisma/Redis once at the end.
- **Real HTTP integration tests.** Every test goes through `supertest` against the actual Express `app` — no middleware is unit-tested in isolation. This mirrors the M1 Attack Console's own philosophy: a test proves something about the deployed behavior, not about a helper function's internals.
- **No factory/fixture library.** Each file inlines its own `signupAndLogin`/`createOrg`/`createProject`/`createIssue`/`slugify` helpers. This is genuinely duplicated across several files — a real, low-priority maintenance item, not fixed in this milestone. **Why not fixed now**: consolidating it would mean touching test files that already pass and work correctly, for a DRY improvement with no behavior change — exactly the kind of change this project's own standing rule (see `ROADMAP.md`) says shouldn't happen without a concrete problem it solves. It's named here, honestly, as a good candidate for a future pass, not silently ignored.
- **Rate-limit budget discipline.** The shared `authLimiter` (one IP-keyed bucket across `/login`, `/signup`, `/refresh` — see `ARCHITECTURE.md`'s Known Trade-offs) also governs test files, since Jest resets its module registry — and that limiter's in-memory store — per file, not per test case. Every file that calls `signupAndLogin` multiple times carries a comment tracking its running request count against the shared 10-req/15-min budget. New tests added to an existing file must account for this (see `comments.test.ts`'s updated header comment after M4).
- **Signup already authenticates.** `POST /api/auth/signup` sets session cookies on its own response (see `issueTokensAndSetCookies` in `auth.ts`) — several tests (including the M4 additions) extract the cookie directly from the signup response instead of spending an extra request on a separate login call.

## What this suite deliberately does not do

- **No mocked Prisma/Redis.** Every test runs against a real (test) Postgres database and real Redis instance — the caching-staleness tests in particular would be meaningless against a mock.
- **No snapshot testing.** Response shapes are asserted field-by-field where it matters (e.g., `hasNextPage`/`nextCursor` correctness), not via brittle full-object snapshots.
- **No coverage-percentage target.** Tests exist because a specific invariant or boundary needed proving, not to hit a number. `TESTING.md` itself is evidence of that: this document was only written after an audit confirmed what's real, rather than asserting a target and writing tests to match it.
