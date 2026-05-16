import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getGitHubAppInstallUrl } from "./install-url";

describe("getGitHubAppInstallUrl", () => {
  const FALLBACK = "https://github.com/apps/antfleet/installations/new";

  beforeEach(() => {
    delete process.env.GITHUB_APP_INSTALL_URL;
  });

  afterEach(() => {
    delete process.env.GITHUB_APP_INSTALL_URL;
  });

  it("returns the fallback URL when env var is not set", () => {
    expect(getGitHubAppInstallUrl()).toBe(FALLBACK);
  });

  it("returns the env var value when set", () => {
    process.env.GITHUB_APP_INSTALL_URL =
      "https://github.com/apps/antfleet-staging/installations/new";
    expect(getGitHubAppInstallUrl()).toBe(
      "https://github.com/apps/antfleet-staging/installations/new",
    );
  });

  it("returns the fallback when env var is explicitly unset after being set", () => {
    process.env.GITHUB_APP_INSTALL_URL = "https://example.com/install";
    delete process.env.GITHUB_APP_INSTALL_URL;
    expect(getGitHubAppInstallUrl()).toBe(FALLBACK);
  });
});
