import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import healthRouter from "./routes/health";
import authRouter from "./routes/auth";
import organizationsRouter from "./routes/organizations";
import projectsRouter from "./routes/projects";
import issuesRouter from "./routes/issues";
import { errorHandler } from "./middleware/errorHandler";
import { authLimiter, generalLimiter } from "./middleware/rateLimiters";

export const app = express();

const allowedOrigins = [
  "http://localhost:3000",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
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

app.use(errorHandler);
