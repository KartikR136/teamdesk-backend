// Generates a finite list of concrete start times for a recurring meeting.
// Deliberately NOT a full RRULE/iCal implementation — see schema.prisma's
// RecurrenceRule comment for why. This is a small, predictable generator
// that materializes real rows up front instead of computing occurrences
// on the fly, which keeps every other route (today's meetings, RSVP,
// notes, issue-linking) working against ordinary Meeting rows.

export type RecurrenceRuleValue =
  | "NONE"
  | "DAILY"
  | "WEEKDAYS"
  | "WEEKLY";

// Hard cap on generated instances per create call — protects the DB from
// a client passing occurrenceCount: 99999, and matches the "predictable,
// bounded" philosophy this codebase uses elsewhere (MAX_PAGE_SIZE, etc.)
export const MAX_RECURRING_OCCURRENCES = 52;

/**
 * Returns an array of Date objects, one per occurrence, starting with
 * `firstStartsAt` itself. For RecurrenceRule.NONE, always returns exactly
 * one date (the meeting itself — not a series at all).
 */
export function generateOccurrences(
  firstStartsAt: Date,
  rule: RecurrenceRuleValue,
  occurrenceCount: number,
): Date[] {
  const count = Math.max(
    1,
    Math.min(occurrenceCount, MAX_RECURRING_OCCURRENCES),
  );

  if (rule === "NONE") {
    return [firstStartsAt];
  }

  const dates: Date[] = [];
  const cursor = new Date(firstStartsAt);

  while (dates.length < count) {
    const day = cursor.getDay(); // 0 = Sunday, 6 = Saturday
    const isWeekday = day !== 0 && day !== 6;

    if (rule === "WEEKDAYS") {
      if (isWeekday) dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    } else if (rule === "DAILY") {
      dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    } else {
      // WEEKLY
      dates.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 7);
    }
  }

  return dates;
}
