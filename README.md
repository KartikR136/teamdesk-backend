# TeamDesk — Backend

A multi-tenant issue-tracking platform (Jira/Linear-lite) built to demonstrate production-grade backend engineering: proper multi-tenancy, role-based access control, secure authentication, and defense-in-depth authorization.

## Why this project exists

Most portfolio CRUD apps have a single user type and no real authorization logic. TeamDesk is deliberately built around the hard part: making sure one organization's data can never leak to another, even under adversarial conditions (guessed IDs, tampered tokens, forged request bodies).

## Architecture

```
┌─────────────┐      HTTPS       ┌──────────────┐      Prisma      ┌────────────┐
│  Next.js     │ ───────────────▶│  Express API │ ─────────────────▶│ PostgreSQL │
│  (Vercel)    │◀─────────────── │  (Render)    │◀───────────────── │  (Neon)    │
└─────────────┘   httpOnly       └──────┬───────┘                  └────────────┘
                   cookies               │
                                         │  cache reads
                                         ▼
                                  ┌──────────────┐
                                  │ Redis         │
                                  │ (Upstash)     │
                                  └──────────────┘
```

## Key engineering decisions

| Decision                                                                                                     | Rationale                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Direct `organizationId` on `Issue` (not just via `Project`)                                                  | Avoids requiring a JOIN on every tenant-scoping check; makes it impossible to accidentally skip the auth check by forgetting a join |
| Role stored on `Membership`, not `User`                                                                      | A user can hold different roles in different organizations — role is a property of the _relationship_, not the _identity_           |
| Access token (15 min) + rotating refresh token (30 days)                                                     | Bounds the damage window of a stolen access token; rotation makes stolen refresh tokens detectable via reuse                        |
| Refresh tokens stored as SHA-256 hashes, not raw                                                             | A database leak alone shouldn't be enough to hijack sessions                                                                        |
| `organizationId` always derived server-side from the authenticated resource, never trusted from client input | Prevents IDOR / cross-tenant access even if the client is fully compromised or malicious                                            |
| Redis-cached membership lookups (60s TTL)                                                                    | Avoids a DB hit on every single authorized request, at the cost of up to 60s staleness on role changes                              |
| Same generic error for wrong-password vs. nonexistent-email                                                  | Prevents user enumeration attacks                                                                                                   |

## Tech stack

- **Backend:** Node.js, Express, TypeScript, Prisma, PostgreSQL, Redis, Zod, Jest + Supertest
- **Frontend:** Next.js (App Router), TypeScript, Tailwind CSS
- **Infra:** Neon (Postgres), Upstash (Redis), Render (backend hosting), Vercel (frontend hosting), GitHub Actions (CI)

## Project structure

```
teamdesk-backend/
├── prisma/
│   └── schema.prisma
├── src/
│   ├── config/
│   │   └── env.ts
│   ├── lib/
│   │   ├── prisma.ts
│   │   ├── redis.ts
│   │   ├── tokens.ts
│   │   ├── password.ts
│   │   └── resolveOrgContext.ts
│   ├── routes/
│   │   ├── health.ts
│   │   ├── auth.ts
│   │   ├── organizations.ts
│   │   ├── projects.ts
│   │   └── issues.ts
│   ├── middleware/
│   │   ├── errorHandler.ts
│   │   ├── requireAuth.ts
│   │   ├── requireRole.ts
│   │   └── rateLimiters.ts
│   ├── test/
│   │   ├── setup.ts
│   │   ├── testUtils.ts
│   │   ├── auth.test.ts
│   │   ├── multiTenant.test.ts
│   │   ├── rbac.test.ts
│   │   ├── validation.test.ts
│   │   └── refreshRotation.test.ts
│   ├── app.ts
│   └── server.ts
├── .github/
│   └── workflows/
│       └── ci.yml
├── .env.example
├── .gitignore
├── jest.config.js
├── package.json
└── tsconfig.json
```

## Local development setup

1. Clone this repo and the companion `teamdesk-frontend` repo.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in real values (see [Environment Variables](#environment-variables) below).
4. Run migrations:
   ```bash
   npx prisma migrate dev
   ```
5. Start the dev server:
   ```bash
   npm run dev
   ```
6. Backend runs at `http://localhost:4000`. Health check: `http://localhost:4000/api/health`.

## Environment variables

| Variable             | Description                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | PostgreSQL connection string (development database)                                                  |
| `TEST_DATABASE_URL`  | Separate PostgreSQL connection string used only by the test suite                                    |
| `JWT_ACCESS_SECRET`  | Signing secret for short-lived access tokens (generate via `crypto.randomBytes(64).toString('hex')`) |
| `JWT_REFRESH_SECRET` | Separate signing secret for refresh-token-related operations                                         |
| `REDIS_URL`          | Redis connection string (Upstash or similar)                                                         |
| `PORT`               | Port the API listens on (defaults to 4000 locally; set automatically by Render in production)        |
| `FRONTEND_URL`       | Production frontend URL, used for CORS allow-listing                                                 |

⚠️ Never commit `.env`. Use different secrets for development, test, and production.

## Running tests

```bash
npm test
```

Runs the full suite against an isolated test database (`TEST_DATABASE_URL`), wiped clean before every test via `src/test/setup.ts`. Current coverage includes:

- Authentication (signup, duplicate email rejection, login enumeration protection)
- Protected route access (missing/invalid/tampered tokens)
- Multi-tenant isolation (cross-org access blocked, cross-org `projectId` injection blocked, cross-org issue updates blocked)
- Role-based access control (VIEWER blocked from privileged actions)
- Input validation (Zod schema enforcement)
- Refresh token rotation and reuse detection

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs the full test suite against a disposable Postgres container on every push and pull request to `main`. See the **Actions** tab on GitHub for run history.

## Deployment

- **Backend:** Render (Node web service). Build command: `npm install && npx prisma generate && npm run build`. Start command: `npm run start`. Migrations are applied manually via `npx prisma migrate deploy` before first deploy and after schema changes — never via `migrate dev` in production.
- **Frontend:** Vercel, with `NEXT_PUBLIC_API_URL` pointed at the deployed Render backend URL.
- **Database:** Neon (PostgreSQL), separate instances/branches for development, test, and production.
- **Cache:** Upstash (Redis).

## Security model summary

Authorization in this system follows one non-negotiable rule: **the server never trusts client-supplied identifiers for authorization decisions.** Every `organizationId` used in a permission check is derived from a database lookup tied to the resource being accessed (e.g., an issue's own stored `organizationId`, not a value read from the URL or request body), and cross-checked against the authenticated user's actual `Membership` record for that organization. This holds for both reads and writes.

Additional measures:

- Passwords hashed with bcrypt (cost factor 12)
- JWT access tokens are short-lived (15 min); refresh tokens rotate on every use and are stored as SHA-256 hashes
- Rate limiting on authentication endpoints (login, signup, refresh)
- Generic, identical error responses for invalid email vs. invalid password (prevents user enumeration)
- Role checks use a numeric hierarchy (`VIEWER < MEMBER < MANAGER < ADMIN`) rather than exact-match checks, so permissions are cumulative and easy to extend

## Roadmap / known follow-ups

- Comments and ActivityLog models exist in the schema but do not yet have API endpoints or UI
- Membership role changes do not yet invalidate the Redis cache automatically (planned alongside a "manage organization members" endpoint)
- Client-side issue filtering was replaced with a properly scoped backend route (`GET /api/organizations/:organizationId/projects/:projectId/issues`)
