import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import healthRouter from "./routes/health";
import authRouter from "./routes/auth";
import organizationsRouter from "./routes/organizations";
import projectsRouter from "./routes/projects";
import issuesRouter from "./routes/issues";
import commentsRouter from "./routes/comments";
import activityRouter from "./routes/activity";
import invitationsRouter from "./routes/invitations";
import membersRouter from "./routes/members";
import decisionsRouter from "./routes/decisions";
import dashboardRouter from "./modules/dashboard/routes/dashboard.routes";
import { errorHandler } from "./middleware/errorHandler";
import {
  loginLimiter,
  signupLimiter,
  refreshLimiter,
  forgotPasswordLimiter,
  generalLimiter,
} from "./middleware/rateLimiters";
import demoAttacksRouter from "./routes/demoAttacks";

export const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Allow all Vercel preview deployments
      if (origin.endsWith(".vercel.app")) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

app.use("/api/auth/login", loginLimiter);
app.use("/api/auth/signup", signupLimiter);
app.use("/api/auth/refresh", refreshLimiter);
app.use("/api/auth/forgot-password", forgotPasswordLimiter);
app.use("/api", generalLimiter);
app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);
app.use("/api/organizations", organizationsRouter);
app.use("/api", projectsRouter); // has full nested paths already
app.use("/api", issuesRouter);
app.use("/api", commentsRouter); // has full nested paths already (issues/:id/comments, comments/:id)
app.use("/api", activityRouter); // has full nested path already (organizations/:id/activity)
app.use("/api", invitationsRouter); // has full nested paths already (organizations/:id/invitations, invitations/me, invitations/:id/accept|reject)
app.use("/api", membersRouter); // has full nested paths already (organizations/:id/members, .../members/:userId)
app.use("/api", decisionsRouter); // has full nested paths already (organizations/:id/decisions, decisions/:id, decisions/:id/status)
app.use("/api/dashboard", dashboardRouter); // intentionally cross-org — see dashboard.controller.ts

// Attack-console demo routes — only exist at all when DEMO_MODE is set.
// See THREAT_MODEL.md for why this must never be enabled against a
// database containing real tenant data.
if (process.env.DEMO_MODE === "true") {
  app.use("/api/_demo", demoAttacksRouter);
}

app.use(errorHandler);
