import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/requireAuth";
import {
  requireRole,
  OrgScopedRequest,
  invalidateMembershipCache,
} from "../middleware/requireRole";
import { resolveOrgFromParam } from "../lib/resolveOrgContext";
import {
  paginationQuerySchema,
  buildPaginationArgs,
  paginateResults,
} from "../lib/pagination";
import { logActivity, ActivityAction } from "../lib/activityLog";

const router = Router();
router.use(requireAuth);

// GET /api/organizations/:organizationId/members
// Any member (VIEWER+) can see the member list.
router.get(
  "/organizations/:organizationId/members",
  resolveOrgFromParam("organizationId"),
  requireRole("VIEWER"),
  async (req: OrgScopedRequest, res) => {
    const parsedQuery = paginationQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return res.status(400).json({ error: parsedQuery.error.flatten() });
    }

    let paginationArgs;
    try {
      paginationArgs = buildPaginationArgs(parsedQuery.data);
    } catch {
      return res.status(400).json({ error: "Invalid cursor" });
    }

    const memberships = await prisma.membership.findMany({
      where: { organizationId: req.organizationId! },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      ...paginationArgs,
    });

    const { data, hasNextPage, nextCursor } = paginateResults(
      memberships,
      parsedQuery.data.limit,
    );

    res.json({ data, hasNextPage, nextCursor });
  },
);

// Shared guard: is `targetUserId` the organization's ONLY admin? Used by
// both role-change (demoting the last admin) and removal (deleting the
// last admin) — same lockout risk, same rule.
async function isLastRemainingAdmin(
  organizationId: string,
  targetUserId: string,
  targetCurrentRole: string,
): Promise<boolean> {
  if (targetCurrentRole !== "ADMIN") return false;
  const otherAdminCount = await prisma.membership.count({
    where: { organizationId, role: "ADMIN", userId: { not: targetUserId } },
  });
  return otherAdminCount === 0;
}

const changeRoleSchema = z.object({
  role: z.enum(["ADMIN", "MANAGER", "MEMBER", "VIEWER"]),
});

// PATCH /api/organizations/:organizationId/members/:userId
// ADMIN-only. Guards against demoting the organization's LAST admin, which
// would leave the org with no one able to manage roles/invitations at all —
// a lockout bug, not just a permissions edge case.
router.patch(
  "/organizations/:organizationId/members/:userId",
  resolveOrgFromParam("organizationId"),
  requireRole("ADMIN"),
  async (req: OrgScopedRequest, res) => {
    const parsed = changeRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const organizationId = req.organizationId!;
    const targetUserId = req.params.userId;
    if (typeof targetUserId !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const existing = await prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId: targetUserId, organizationId },
      },
    });
    if (!existing) {
      return res
        .status(404)
        .json({ error: "This user is not a member of the organization" });
    }

    if (
      parsed.data.role !== "ADMIN" &&
      (await isLastRemainingAdmin(organizationId, targetUserId, existing.role))
    ) {
      return res.status(400).json({
        error: "Cannot change the role of the organization's last admin",
      });
    }

    const updated = await prisma.membership.update({
      where: {
        userId_organizationId: { userId: targetUserId, organizationId },
      },
      data: { role: parsed.data.role },
    });

    // Closes the M4 gap: without this, the target's OLD role could remain
    // cached for up to 60s after this update, letting a just-demoted user
    // (or a not-yet-recognized promotion) act on stale permissions.
    await invalidateMembershipCache(targetUserId, organizationId);

    await logActivity({
      organizationId,
      userId: req.userId!,
      action: ActivityAction.MEMBER_ROLE_CHANGED,
      metadata: {
        targetUserId,
        oldRole: existing.role,
        newRole: parsed.data.role,
      },
    });

    res.json(updated);
  },
);

// DELETE /api/organizations/:organizationId/members/:userId
// ADMIN-only (including removing yourself, if you're not the last admin —
// there's no separate self-service "leave organization" flow in this
// milestone; that's a reasonable follow-up but wasn't asked for here).
// Same last-admin lockout guard as role change.
router.delete(
  "/organizations/:organizationId/members/:userId",
  resolveOrgFromParam("organizationId"),
  requireRole("ADMIN"),
  async (req: OrgScopedRequest, res) => {
    const organizationId = req.organizationId!;
    const targetUserId = req.params.userId;
    if (typeof targetUserId !== "string") {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const existing = await prisma.membership.findUnique({
      where: {
        userId_organizationId: { userId: targetUserId, organizationId },
      },
    });
    if (!existing) {
      return res
        .status(404)
        .json({ error: "This user is not a member of the organization" });
    }

    if (
      await isLastRemainingAdmin(organizationId, targetUserId, existing.role)
    ) {
      return res
        .status(400)
        .json({ error: "Cannot remove the organization's last admin" });
    }

    await prisma.membership.delete({
      where: {
        userId_organizationId: { userId: targetUserId, organizationId },
      },
    });

    // Closes the sharper M4 gap: without this, a removed member could still
    // pass requireRole on any org route for up to 60s — full access that
    // should be immediately revoked, not just a wrong permission level.
    await invalidateMembershipCache(targetUserId, organizationId);

    await logActivity({
      organizationId,
      userId: req.userId!,
      action: ActivityAction.MEMBER_REMOVED,
      metadata: { targetUserId, removedRole: existing.role },
    });

    res.status(204).send();
  },
);

export default router;
