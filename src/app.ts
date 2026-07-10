import express from "express";
import cors from "cors";
import healthRouter from "./routes/health";
import { errorHandler } from "./middleware/errorHandler";

export const app = express();

app.use(cors({ origin: "http://localhost:3000" }));
app.use(express.json());

app.use("/api/health", healthRouter);

app.use(errorHandler);
