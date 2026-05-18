/**
 * Returns the GitHub App installation URL.
 * Falls back to the canonical installation path if the env var is not set.
 */
export function getGitHubAppInstallUrl(): string {
  return process.env.GITHUB_APP_INSTALL_URL ?? "https://github.com/apps/antfleet/installations/new";
}
