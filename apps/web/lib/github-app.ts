import { createAppAuth } from "@octokit/auth-app";

// Lazily build the auth instance — keeps env reads scoped to handler invocation
// so a missing key surfaces as a 5xx-with-clear-log, not a process-start crash.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

export type AppAuth = ReturnType<typeof createAppAuth>;

export function appAuth(): AppAuth {
  return createAppAuth({
    appId: requireEnv("GITHUB_APP_ID"),
    privateKey: requireEnv("GITHUB_APP_PRIVATE_KEY"),
  });
}

// Exchange App-level JWT for a short-lived installation token. The token is
// scoped to one installation and expires in ~1 hour. Each webhook invocation
// gets a fresh token; we do not cache (low call volume in v1; revisit if it
// shows up in latency profiling).
export async function getInstallationToken(installationId: number): Promise<string> {
  const auth = appAuth();
  const result = await auth({ type: "installation", installationId });
  return result.token;
}
