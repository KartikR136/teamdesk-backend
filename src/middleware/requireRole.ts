import { Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest } from "./requireAuth";
import { redis } from "../lib/redis";
import { Role, Membership } from "@prisma/client";

const MEMBERSHIP_CACHE_TTL_SECONDS = 60;

async function getMembership(
  userId: string,
  organizationId: string,
): Promise<Membership | null> {
  const cacheKey = `membership:${userId}:${organizationId}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return cached === "null" ? null : (JSON.parse(cached) as Membership);
  }

  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
  });

  // Cache the negative result too ("null") — prevents repeated DB hits
  // for a user probing orgs they don't belong to.
  await redis.set(
    cacheKey,
    membership ? JSON.stringify(membership) : "null",
    "EX",
    MEMBERSHIP_CACHE_TTL_SECONDS,
  );

  return membership;
}
// Role hierarchy — higher number = more permissions.
// Used so "requireRole(MEMBER)" also allows ADMIN/MANAGER, not just exact match.
const ROLE_RANK: Record<Role, number> = {
  VIEWER: 0,
  MEMBER: 1,
  MANAGER: 2,
  ADMIN: 3,
};

export interface OrgScopedRequest extends AuthedRequest {
  organizationId?: string;
  membershipRole?: Role;
}

// This does NOT read organizationId from the client. It reads it from
// whatever the route-specific resource loader already determined and
// attached to the request (see issues.ts for how that happens).
export function requireRole(minRole: Role) {
  return async (req: OrgScopedRequest, res: Response, next: NextFunction) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    if (!req.organizationId) {
      // Programmer error, not a client error — a route used this middleware
      // without first resolving which org the resource belongs to.
      return res.status(500).json({ error: "Organization context missing" });
    }

    const membership = await getMembership(req.userId, req.organizationId);

    if (!membership) {
      return res
        .status(403)
        .json({ error: "Not a member of this organization" });
    }

    if (ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    req.membershipRole = membership.role;
    next();
  };
}
