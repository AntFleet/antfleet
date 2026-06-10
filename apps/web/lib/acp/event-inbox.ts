import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";

type Queryable = Pick<typeof db, "execute">;
export type AcpEventInboxStatus =
  | "pending"
  | "processing"
  | "processed"
  | "failed"
  | "dead_lettered";

export type AcpEventInboxRow = {
  eventKey: string;
  created: boolean;
  status: AcpEventInboxStatus;
};

export type AcpDueProviderEvent = {
  eventKey: string;
  payload: Record<string, unknown>;
};

const MAX_EVENT_ATTEMPTS = 5;

export async function recordAcpProviderEvent(
  q: Queryable,
  event: Record<string, unknown>,
): Promise<AcpEventInboxRow> {
  const eventKey = acpProviderEventKey(event);
  const eventType = readString(event, "type") ?? readString(event, "event") ?? "unknown";
  const acpJobId = readString(event, "jobId") ?? readString(event, "job_id");
  const result = await q.execute(sql`
    INSERT INTO acp_provider_events (
      event_key, acp_job_id, event_type, payload, status, attempts
    ) VALUES (
      ${eventKey}, ${acpJobId}, ${eventType}, ${JSON.stringify(event)}::jsonb, 'pending', 0
    )
    ON CONFLICT (event_key) DO NOTHING
    RETURNING event_key
  `);
  const inserted = firstRow<{ event_key: string }>(result) !== null;
  if (inserted) return { eventKey, created: true, status: "pending" };
  const existing = await q.execute(sql`
    SELECT status
    FROM acp_provider_events
    WHERE event_key = ${eventKey}
    LIMIT 1
  `);
  const row = firstRow<{ status: AcpEventInboxStatus }>(existing);
  return { eventKey, created: false, status: row?.status ?? "pending" };
}

export async function claimAcpProviderEvent(
  q: Queryable,
  eventKey: string,
  now: Date,
): Promise<boolean> {
  const result = await q.execute(sql`
    UPDATE acp_provider_events
    SET status = 'processing',
        attempts = attempts + 1,
        next_retry_at = ${processingLeaseUntil(now)}
    WHERE event_key = ${eventKey}
      AND status IN ('pending','failed','processing')
      AND attempts < ${MAX_EVENT_ATTEMPTS}
      AND (next_retry_at IS NULL OR next_retry_at <= ${now})
    RETURNING event_key
  `);
  return firstRow<{ event_key: string }>(result) !== null;
}

export async function markAcpProviderEventProcessed(
  q: Queryable,
  eventKey: string,
  now: Date,
): Promise<void> {
  await q.execute(sql`
    UPDATE acp_provider_events
    SET status = 'processed',
        failure_message = NULL,
        processed_at = ${now},
        next_retry_at = NULL
    WHERE event_key = ${eventKey}
      AND status = 'processing'
  `);
}

export async function markAcpProviderEventFailed(
  q: Queryable,
  eventKey: string,
  message: string,
  now: Date,
): Promise<void> {
  const attempts = await readAcpProviderEventAttempts(q, eventKey);
  const terminal = attempts >= MAX_EVENT_ATTEMPTS;
  await q.execute(sql`
    UPDATE acp_provider_events
    SET status = ${terminal ? "dead_lettered" : "failed"},
        failure_message = ${message.slice(0, 1000)},
        next_retry_at = ${terminal ? null : nextRetryAt(now, attempts)}
    WHERE event_key = ${eventKey}
      AND status = 'processing'
  `);
}

export async function findDueAcpProviderEvents(
  q: Queryable,
  now: Date,
  limit: number,
): Promise<AcpDueProviderEvent[]> {
  const result = await q.execute(sql`
    SELECT event_key AS "eventKey", payload
    FROM acp_provider_events
    WHERE status IN ('pending','failed','processing')
      AND (next_retry_at IS NULL OR next_retry_at <= ${now})
      AND attempts < ${MAX_EVENT_ATTEMPTS}
    ORDER BY created_at ASC
    LIMIT ${limit}
  `);
  return rows<{ eventKey: string; payload: unknown }>(result)
    .filter(
      (row): row is { eventKey: string; payload: Record<string, unknown> } =>
        typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload),
    )
    .map((row) => ({ eventKey: row.eventKey, payload: row.payload }));
}

async function readAcpProviderEventAttempts(q: Queryable, eventKey: string): Promise<number> {
  const result = await q.execute(sql`
    SELECT attempts
    FROM acp_provider_events
    WHERE event_key = ${eventKey}
    LIMIT 1
  `);
  const row = firstRow<{ attempts: number }>(result);
  return typeof row?.attempts === "number" ? row.attempts : 0;
}

function nextRetryAt(now: Date, attempt: number): Date {
  const delaySeconds = Math.min(15 * 2 ** Math.max(0, attempt - 1), 15 * 60);
  return new Date(now.getTime() + delaySeconds * 1000);
}

function processingLeaseUntil(now: Date): Date {
  return new Date(now.getTime() + 5 * 60 * 1000);
}

export function acpProviderEventKey(event: Record<string, unknown>): string {
  const explicit =
    readString(event, "id") ??
    readString(event, "eventId") ??
    readString(event, "event_id") ??
    readString(event, "messageId") ??
    readString(event, "message_id");
  if (explicit !== null) return explicit;
  const digest = createHash("sha256").update(stableStringify(event)).digest("hex");
  return `sha256:${digest}`;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function firstRow<T>(result: unknown): T | null {
  if (Array.isArray(result)) return (result[0] as T | undefined) ?? null;
  const resultRows = (result as { rows?: T[] } | null)?.rows;
  return resultRows?.[0] ?? null;
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}
