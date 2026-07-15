// Centralized structured logging for authorization decisions.
//
// Every denial in requireAuth/requireRole calls this instead of console.log
// directly, so there is exactly one place that knows the log schema and
// exactly one place to change when this project has a real log destination
// (Render's log stream, Datadog, Grafana Loki, OpenTelemetry, etc.) — none
// of the call sites need to change when that day comes.
//
// No persistence layer here deliberately. A durable AuthDenial table or a
// /security-summary aggregation endpoint would immediately raise real
// questions this project isn't ready to answer yet (retention policy,
// indexing, GDPR/PII handling, cleanup, archival) — see THREAT_MODEL.md /
// ARCHITECTURE.md for why that's named as a deferred next step, not an
// oversight.

export type AuthEventName = "AUTH_DENIED" | "ROLE_DENIED";

export type AuthDenialReason =
  | "NO_TOKEN"
  | "INVALID_OR_EXPIRED_TOKEN"
  | "NOT_A_MEMBER"
  | "INSUFFICIENT_ROLE";

export interface AuthEvent {
  event: AuthEventName;
  decision: "DENY";
  statusCode: 401 | 403;
  reason: AuthDenialReason;
  route: string;
  method: string;
  organizationId: string | null;
  userId: string | null;
  requiredRole: string | null;
  actualRole: string | null;
  // Reserved for a future correlation-ID milestone. Always null today —
  // no request-id middleware exists yet — but the field's presence now
  // means adopting one later is an additive change to this function's
  // callers, not a schema migration.
  requestId: string | null;
}

export function logAuthEvent(event: Omit<AuthEvent, "decision">): void {
  const payload: AuthEvent & { timestamp: string } = {
    timestamp: new Date().toISOString(),
    decision: "DENY",
    ...event,
  };

  // One line of structured JSON per denial. Deliberately console.log, not
  // console.error — this is expected, handled application behavior (a
  // request was correctly denied), not an application error.
  console.log(JSON.stringify(payload));
}
