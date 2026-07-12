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
import { errorHandler } from "./middleware/errorHandler";
import { authLimiter, generalLimiter } from "./middleware/rateLimiters";

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

app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);
app.use("/api/auth/refresh", authLimiter);
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

app.use(errorHandler);
