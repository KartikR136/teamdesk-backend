import { prisma } from "./prisma";

// Matches "@Full Name" or "@word" tokens in a comment body. Names can
// contain spaces (this app has no @username handle, just a `name` field),
// so greedy matching stops at the next @, newline, or common sentence
// punctuation rather than the first space — "@Jane Doe, thanks!" should
// resolve to "Jane Doe", not just "Jane".
const MENTION_PATTERN = /@([^\n@,.!?;:]+)/g;

/**
 * Extracts @mentions from a comment body and resolves them to real,
 * org-member user ids. Only matches members of the given organization —
 * mentioning a name that isn't a member (typo, or someone outside the
 * org) silently resolves to nothing rather than erroring the whole
 * comment post.
 */
export async function resolveMentions(
  body: string,
  organizationId: string,
): Promise<{ userId: string; name: string }[]> {
  const candidates = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) {
    const name = match[1].trim();
    if (name.length > 0) candidates.add(name);
  }
  if (candidates.size === 0) return [];

  const members = await prisma.membership.findMany({
    where: {
      organizationId,
      user: { name: { in: Array.from(candidates) } },
    },
    select: { user: { select: { id: true, name: true } } },
  });

  return members.map((m) => ({ userId: m.user.id, name: m.user.name }));
}
