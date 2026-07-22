import { Response, NextFunction } from "express";
import { prisma } from "../lib/prisma";
import { AuthedRequest } from "./requireAuth";
import { redis } from "../lib/redis";
import { Role, Membership } from "@prisma/client";
import { logAuthEvent } from "../lib/logAuthEvent";

const MEMBERSHIP_CACHE_TTL_SECONDS = 60;

function membershipCacheKey(userId: string, organizationId: string): string {
  return `membership:${userId}:${organizationId}`;
}

async function getMembership(
  userId: string,
  organizationId: string,
): Promise<Membership | null> {
  const cacheKey = membershipCacheKey(userId, organizationId);

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

// Call this immediately after ANY mutation that changes a user's membership
// state in an org: role change, removal, or a new membership being created
// (e.g. accepting an invitation). Without this, the mutation is correct in
// the database but the NEXT request from that user could still read a
// stale cached role/negative-membership result for up to 60s.
//
// Deliberately narrow: only deletes the one (userId, organizationId) key
// affected by the mutation that just happened — not a broader flush — so
// this stays cheap and doesn't clear unrelated cached memberships.
export async function invalidateMembershipCache(
  userId: string,
  organizationId: string,
): Promise<void> {
  await redis.del(membershipCacheKey(userId, organizationId));
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

export interface RequireRoleOptions {
  // Set ONLY by routes using a resource-derived resolver (resolveOrgFromIssue/
  // Project/Comment/Decision) — never by resolveOrgFromParam routes.
  //
  // Why this matters: for a param-derived route, the client already supplied
  // the organizationId in the URL, so confirming "you're not a member" (403)
  // reveals nothing they didn't already state themselves. For a resource-
  // derived route (e.g. GET /issues/:issueId), the client only supplied a
  // resource ID — a 403 would confirm "this resource exists, in some org,
  // you're just not in it," while a 404 reveals nothing about whether the
  // resource exists anywhere at all. API.md has documented 404 as the
  // intended behavior here since before this fix; this flag is what makes
  // the code actually match that documentation instead of returning a
  // uniform 403 regardless of how org context was resolved.
  //
  // Deliberately does NOT change the "insufficient role" branch below —
  // that only fires once a real Membership was already found, so there's
  // no existence-of-resource ambiguity left to protect; a genuine member
  // with too low a rank still correctly gets 403.
  notFoundIfNoMembership?: boolean;
}

// This does NOT read organizationId from the client. It reads it from
// whatever the route-specific resource loader already determined and
// attached to the request (see issues.ts for how that happens).
export function requireRole(minRole: Role, options: RequireRoleOptions = {}) {
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
      logAuthEvent({
        event: "ROLE_DENIED",
        statusCode: options.notFoundIfNoMembership ? 404 : 403,
        reason: "NOT_A_MEMBER",
        route: req.originalUrl,
        method: req.method,
        organizationId: req.organizationId,
        userId: req.userId,
        requiredRole: minRole,
        actualRole: null,
        requestId: null,
      });

      if (options.notFoundIfNoMembership) {
        // Deliberately generic — must be indistinguishable from "this
        // resource genuinely doesn't exist anywhere," which is exactly
        // what resolveOrgFromIssue/Project/Comment/Decision themselves
        // return when the row truly doesn't exist. Do not add org- or
        // resource-specific detail to this message.
        return res.status(404).json({ error: "Not found" });
      }

      return res
        .status(403)
        .json({ error: "Not a member of this organization" });
    }

    if (ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
      logAuthEvent({
        event: "ROLE_DENIED",
        statusCode: 403,
        reason: "INSUFFICIENT_ROLE",
        route: req.originalUrl,
        method: req.method,
        organizationId: req.organizationId,
        userId: req.userId,
        requiredRole: minRole,
        actualRole: membership.role,
        requestId: null,
      });
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    req.membershipRole = membership.role;
    next();
  };
}
