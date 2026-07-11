import { z } from "zod";

// Cursor pagination, not offset pagination.
//
// Why: OFFSET N requires the database to walk and discard N rows before it can
// start returning results — cost grows linearly with page depth. A cursor lets
// the DB seek directly via an indexed WHERE clause regardless of how deep the
// page is. This matters once a table has real volume; it's free to get right
// now while the routes are still small.
//
// Cursor shape: { createdAt, id }, not just { id }.
// createdAt alone isn't safe as a sort key on its own — two rows can share the
// same millisecond timestamp, which would make pagination skip or repeat rows
// at that boundary. id (UUID) has no natural ordering a user would want, but
// it IS globally unique, so it works as a tiebreaker. Together they give a
// stable, deterministic sort with no gaps or duplicates across pages.
//
// The cursor is opaque to the client (base64 JSON) rather than raw column
// values, so callers can't hand-construct arbitrary cursors and the encoding
// can change later without breaking the API contract.

export interface CursorPayload {
  createdAt: string; // ISO string
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCursor(raw: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string"
    ) {
      return parsed as CursorPayload;
    }
    return null;
  } catch {
    return null;
  }
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// Query-string schema shared by every paginated list endpoint.
// limit is capped server-side — an uncapped limit would let a client request
// limit=999999 and defeat the entire point of paginating.
export const paginationQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_SIZE)
    .optional()
    .default(DEFAULT_PAGE_SIZE),
  cursor: z.string().optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * Builds the Prisma findMany args for cursor-based pagination on a model
 * that has `createdAt` and `id` fields. Fetches limit+1 rows so we can tell
 * whether there's a next page without a separate count query.
 */
export function buildPaginationArgs(query: PaginationQuery) {
  const { limit, cursor } = query;

  const decoded = cursor ? decodeCursor(cursor) : null;
  if (cursor && !decoded) {
    // Invalid/tampered cursor. Caller decides how to respond (400).
    throw new Error("INVALID_CURSOR");
  }

  return {
    take: limit + 1, // over-fetch by one to detect hasNextPage
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    ...(decoded
      ? {
          cursor: { id: decoded.id },
          skip: 1, // skip the cursor row itself, it was already returned
        }
      : {}),
  };
}

/**
 * Given the over-fetched rows (limit+1) and the requested limit, slices back
 * down to `limit` and computes hasNextPage/nextCursor.
 */
export function paginateResults<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
) {
  const hasNextPage = rows.length > limit;
  const page = hasNextPage ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    data: page,
    hasNextPage,
    nextCursor:
      hasNextPage && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}
