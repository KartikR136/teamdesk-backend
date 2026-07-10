import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../lib/tokens";

export interface AuthedRequest extends Request {
  userId?: string;
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) {
  const token = req.cookies?.accessToken;

  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.userId;
    next();
  } catch {
    // Covers both expired and tampered tokens — same response either way,
    // so we don't leak which failure mode occurred to a potential attacker.
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
