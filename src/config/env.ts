import dotenv from "dotenv";
dotenv.config();

export const env = {
  port: process.env.PORT || 4000,
  databaseUrl: process.env.DATABASE_URL,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  redisUrl: process.env.REDIS_URL,
};

if (!env.databaseUrl) throw new Error("DATABASE_URL is not set in .env");
if (!env.jwtAccessSecret)
  throw new Error("JWT_ACCESS_SECRET is not set in .env");
if (!env.jwtRefreshSecret)
  throw new Error("JWT_REFRESH_SECRET is not set in .env");
if (!env.redisUrl) throw new Error("REDIS_URL is not set in .env");
