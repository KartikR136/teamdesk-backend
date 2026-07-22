import dotenv from "dotenv";
dotenv.config();

// CSRF_ENABLED is intentionally tri-state at the env-var level:
//   - unset in a normal (non-test) environment  -> defaults to true (secure by default)
//   - unset while NODE_ENV=test                 -> defaults to false (the existing
//     supertest suites authenticate via cookies but don't simulate the
//     browser-side CSRF-header dance)
//   - explicitly set ("true"/"false") -> always wins, in any environment
const csrfEnvValue = process.env.CSRF_ENABLED;

export const env = {
  port: process.env.PORT || 4000,
  databaseUrl: process.env.DATABASE_URL,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  redisUrl: process.env.REDIS_URL,
  csrfEnabled:
    csrfEnvValue !== undefined
      ? csrfEnvValue === "true"
      : process.env.NODE_ENV !== "test",
};

if (!env.databaseUrl) throw new Error("DATABASE_URL is not set in .env");
if (!env.jwtAccessSecret)
  throw new Error("JWT_ACCESS_SECRET is not set in .env");
if (!env.jwtRefreshSecret)
  throw new Error("JWT_REFRESH_SECRET is not set in .env");
if (!env.redisUrl) throw new Error("REDIS_URL is not set in .env");
