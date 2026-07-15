import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../lib/tokens";
import { logAuthEvent } from "../lib/logAuthEvent";

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
    logAuthEvent({
      event: "AUTH_DENIED",
      statusCode: 401,
      reason: "NO_TOKEN",
      route: req.originalUrl,
      method: req.method,
      organizationId: null,
      userId: null,
      requiredRole: null,
      actualRole: null,
      requestId: null,
    });
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const payload = verifyAccessToken(token);
    req.userId = payload.userId;
    next();
  } catch {
    // Covers both expired and tampered tokens — same response either way,
    // so we don't leak which failure mode occurred to a potential attacker.
    logAuthEvent({
      event: "AUTH_DENIED",
      statusCode: 401,
      reason: "INVALID_OR_EXPIRED_TOKEN",
      route: req.originalUrl,
      method: req.method,
      organizationId: null,
      userId: null,
      requiredRole: null,
      actualRole: null,
      requestId: null,
    });
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
