# TeamDesk — Backend

Express + TypeScript + Prisma + PostgreSQL backend for TeamDesk, a secure multi-tenant issue-tracking platform.

Full documentation (architecture, API reference, deployment guide, roadmap) lives in the frontend repo:

- [Architecture](https://github.com/KartikR136/teamdesk-frontend/blob/main/ARCHITECTURE.md)
- [API Reference](https://github.com/KartikR136/teamdesk-frontend/blob/main/API.md)
- [Deployment Guide](https://github.com/KartikR136/teamdesk-frontend/blob/main/DEPLOYMENT.md)

## Quick start

```bash
npm install
cp .env.example .env
npx prisma migrate deploy
npm run dev
```
