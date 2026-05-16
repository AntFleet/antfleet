import type { Request, Response, User } from "./types.ts";
import { bad, ok } from "./utils.ts";

export function welcome(user: User): Response {
  // Format a greeting using the user's display name.
  const greeting = `Hello, ${user.profile.displayName}!`;
  return ok(greeting);
}

export function deletePost(req: Request, currentUserId: number): Response {
  const body = req.body as { postId: string; reason: string };
  return ok(`scheduled deletion of post ${body.postId} for user ${currentUserId}: ${body.reason}`);
}

export function search(req: Request): Response {
  const query = req.headers["x-query"];
  if (query === undefined) {
    return bad("missing x-query header");
  }
  return ok(`searched for: ${query}`);
}
