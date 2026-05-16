export function ok(body: string): { status: number; body: string } {
  return { status: 200, body };
}

export function bad(message: string): { status: number; body: string } {
  return { status: 400, body: JSON.stringify({ error: message }) };
}

export function notFound(): { status: number; body: string } {
  return { status: 404, body: JSON.stringify({ error: "not found" }) };
}
