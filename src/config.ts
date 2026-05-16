import { join, resolve } from "node:path";
import { FleetConfig, configSchema, ProjectCommands } from "./types.js";
import { pathExists, readJson } from "./fs.js";

export type GlobalOptions = {
  root?: string;
  stateDir?: string;
  config?: string;
  json: boolean;
  plain: boolean;
  quiet: boolean;
  verbose: boolean;
  debug: boolean;
  noColor: boolean;
  noInput: boolean;
};

export const defaultCommands: ProjectCommands = {
  typecheck: null,
  lint: null,
  format: null,
  test: null,
};

export function defaultConfig(): FleetConfig {
  return {
    schemaVersion: 1,
    stateDir: ".fleet",
    include: ["**/*"],
    exclude: [
      "node_modules/**",
      "dist/**",
      "build/**",
      "target/**",
      ".build/**",
      ".git/**",
      ".fleet/**",
    ],
    provider: {
      name: "codex",
      model: null,
    },
    commands: defaultCommands,
    review: {
      maxContextFiles: 24,
      maxOwnedFiles: 12,
      maxFindingsPerFeature: 10,
      minConfidenceToFix: "medium",
    },
    git: {
      requireCleanWorktreeForFix: true,
      commit: false,
      openPr: false,
    },
  };
}

export async function loadConfig(root: string, options: GlobalOptions): Promise<FleetConfig> {
  const configPath = await discoverConfigPath(root, options);
  const base = configPath === null ? defaultConfig() : await readJson(configPath, configSchema);
  return {
    ...base,
    stateDir: options.stateDir ?? process.env["FLEET_STATE_DIR"] ?? base.stateDir,
    provider: {
      ...base.provider,
      name: process.env["FLEET_PROVIDER"] ?? base.provider.name,
      model: process.env["FLEET_MODEL"] ?? base.provider.model,
    },
  };
}

export function resolveStateDir(root: string, config: FleetConfig): string {
  return resolve(root, config.stateDir);
}

async function discoverConfigPath(root: string, options: GlobalOptions): Promise<string | null> {
  if (options.config !== undefined) {
    return resolve(options.config);
  }
  if (process.env["FLEET_CONFIG"] !== undefined) {
    return resolve(process.env["FLEET_CONFIG"]);
  }
  const configuredStateDir = options.stateDir ?? process.env["FLEET_STATE_DIR"];
  const candidates = [
    ...(configuredStateDir === undefined
      ? []
      : [join(resolve(root, configuredStateDir), "config.json")]),
    join(root, "fleet.config.json"),
    join(root, ".fleet", "config.json"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}
