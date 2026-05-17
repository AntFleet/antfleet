export class FleetError extends Error {
  public readonly exitCode: number;
  public readonly code: string;

  public constructor(message: string, exitCode = 1, code = "runtime") {
    super(message);
    this.name = "FleetError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

export function assertDefined<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new FleetError(message);
  }
  return value;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
