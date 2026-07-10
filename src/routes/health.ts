import { Router } from "express";
import { prisma } from "../lib/prisma";

const router = Router();

router.get("/", async (_req, res) => {
  try {
    // Read-only check: proves the DB connection is alive without writing data.
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", dbConnected: true });
  } catch (err) {
    res.status(500).json({ status: "error", dbConnected: false });
  }
});

export default router;
