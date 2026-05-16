// Structured logger — JSON per line on stdout. The audit-trail substrate
// referenced in AGENTS.md §11.2: every review event, provider call, agreement
// decision, and sweeper action emits a single parseable JSON object. Downstream
// metrics, eval pipelines, and the data flywheel read from these.
//
// Keep the API tiny: an event name and a flat object of fields. No string
// formatting, no log levels beyond the four below, no async sinks. If something
// needs to ship logs elsewhere, that's a layer on top of this.

type Level = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

export function log(level: Level, event: string, fields: LogFields = {}): void {
  // Base fields go LAST so a caller-supplied `event` / `level` / `ts` field
  // can't accidentally shadow them. The log event name and severity are the
  // logger's contract; everything else is contextual.
  const entry = {
    ...fields,
    ts: new Date().toISOString(),
    level,
    event,
  };
  // eslint-disable-next-line no-console -- log() is the sanctioned writer.
  console.log(JSON.stringify(entry));
}

export const logInfo = (event: string, fields?: LogFields): void => log("info", event, fields);
export const logWarn = (event: string, fields?: LogFields): void => log("warn", event, fields);
export const logError = (event: string, fields?: LogFields): void => log("error", event, fields);
export const logDebug = (event: string, fields?: LogFields): void => log("debug", event, fields);
