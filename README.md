# TeamDesk — Backend

Express + TypeScript + Prisma + PostgreSQL backend for TeamDesk, a secure multi-tenant issue-tracking platform.

Full documentation (architecture, API reference, deployment guide, roadmap) lives in the frontend repo:

- [Architecture](https://github.com/KartikR136/teamdesk-frontend/blob/main/ARCHITECTURE.md)
- [API Reference](https://github.com/KartikR136/teamdesk-frontend/blob/main/API.md)
- [Deployment Guide](https://github.com/KartikR136/teamdesk-frontend/blob/main/DEPLOYMENT.md)

## Developer Home Dashboard

`GET /api/dashboard/home` — a single, optimized endpoint aggregating everything a developer needs on login. See [docs/DASHBOARD.md](docs/DASHBOARD.md) for the full architecture, provider-extension guide, and frontend integration notes.

## Quick start

```bash
npm install
cp .env.example .env
npx prisma migrate deploy
npm run dev
```

**After pulling this change**, run `npx prisma generate` and `npx prisma migrate deploy` (or `migrate dev` locally) — a new migration (`20260718060000_add_dashboard_support`) adds the `Notification` and `RecentlyViewedIssue` tables and an `Issue.dueDate` column.
