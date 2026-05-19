export function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

export function decodeCursor(token: string, expectedLength: number): unknown[] | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
