// Regression fixtures for the two-model review gate.
//
// Each fixture is a real, syntactically-valid, KNOWN-SAFE code pattern that
// sits on a common false-positive attractor — the kind of thing a single
// reviewer might flag but that is correct in context. The unanimous gate
// (both Opus and GPT-5 must independently flag the same thing) should NEVER
// fire on any of these. The weekly regression cron runs them through the real
// pipeline; if the gate fires, that's a drift signal (a silent provider model
// update changed review behavior) and the cron alerts.
//
// To add a fixture: write COMPLETE, valid code (it is sent verbatim to the
// models as a changed file), and make `description` state explicitly WHY the
// pattern is safe.

export interface RegressionFixture {
  // Stable slug, e.g. "rust-nonnull-unchecked". Used in logs + the cron's
  // failure list, so keep it permanent once shipped.
  id: string;
  // "rust" | "typescript" | "solidity" | "bash" | "python" | ... — drives the
  // synthetic filename extension the gate sees.
  language: string;
  // One line: WHY this pattern is safe. Read by a human auditing a drift alert.
  description: string;
  // The code snippet to review. Complete + valid for its language.
  code: string;
}

export const REGRESSION_FIXTURES: RegressionFixture[] = [
  {
    id: "rust-nonnull-unchecked",
    language: "rust",
    description:
      "NonNull::new_unchecked is sound here: the pointer comes from a live &mut T, and Rust references are guaranteed non-null, so the new_unchecked precondition is statically upheld. The unsafe block has a documented SAFETY invariant.",
    code: `use std::ptr::NonNull;

/// Wraps a \`&mut T\` as a \`NonNull<T>\`.
pub fn as_non_null<T>(reference: &mut T) -> NonNull<T> {
    // SAFETY: \`reference\` is a live \`&mut T\`. Rust references are never null
    // and are always well-aligned, so the non-null precondition required by
    // \`NonNull::new_unchecked\` is guaranteed by the type system here.
    unsafe { NonNull::new_unchecked(reference as *mut T) }
}
`,
  },
  {
    id: "ts-eval-allowlisted-constant",
    language: "typescript",
    description:
      "eval() runs only a compile-time literal selected from a frozen allowlist keyed by a typed union; no user-controlled string can reach eval, so there is no code-injection surface.",
    code: `// The only strings eval() ever sees are these frozen, author-written literals.
const EXPRESSIONS = Object.freeze({
  doubled: "2 * 21",
  squared: "7 * 7",
} as const);

export function evalNamedExpression(key: keyof typeof EXPRESSIONS): number {
  const expr = EXPRESSIONS[key];
  if (typeof expr !== "string") {
    throw new Error(\`unknown expression key: \${String(key)}\`);
  }
  // The argument is a compile-time constant from a frozen allowlist indexed by
  // a typed key — no external input reaches this call.
  return eval(expr) as number;
}
`,
  },
  {
    id: "solidity-selfdestruct-guarded",
    language: "solidity",
    description:
      "selfdestruct is gated behind BOTH an onlyOwner modifier AND a pre-armed 7-day timelock, so it cannot be triggered by an attacker, nor by the owner without an announced delay.",
    code: `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract GuardedTeardown {
    address public immutable owner;
    uint256 public teardownReadyAt; // 0 = not armed

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function armTeardown() external onlyOwner {
        teardownReadyAt = block.timestamp + 7 days;
    }

    function teardown(address payable recipient) external onlyOwner {
        require(teardownReadyAt != 0, "not armed");
        require(block.timestamp >= teardownReadyAt, "timelock active");
        selfdestruct(recipient);
    }
}
`,
  },
  {
    id: "js-prototype-freeze-hardening",
    language: "javascript",
    description:
      "Object.freeze(Object.prototype) is a prototype-pollution DEFENSE, not pollution: it writes nothing to the prototype and prevents any later code from adding or overriding properties on it.",
    code: `// Hardening: freeze the built-in prototypes so no later code (including a
// compromised dependency) can pollute them. Nothing is written to the
// prototypes here — freezing is the mitigation, not an instance of pollution.
export function hardenBuiltinPrototypes() {
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  Object.freeze(Function.prototype);
}
`,
  },
  {
    id: "bash-curl-checksummed",
    language: "bash",
    description:
      "The installer downloads to a temp file and verifies it against a pinned SHA-256 BEFORE executing, aborting on mismatch — the safe counterpart to `curl | sh`; no unverified remote code is ever run.",
    code: `#!/usr/bin/env bash
set -euo pipefail

URL="https://releases.example.com/install.sh"
EXPECTED_SHA256="9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

curl -fsSL "$URL" -o "$tmp"
# Abort unless the download matches the pinned hash. Only verified bytes run.
echo "\${EXPECTED_SHA256}  \${tmp}" | sha256sum --check --status

bash "$tmp"
`,
  },
  {
    id: "python-subprocess-no-shell",
    language: "python",
    description:
      "subprocess.run is called with an argv LIST and shell=False (default), and a `--` end-of-options guard, so an untrusted `ref` is a single argv element the shell never interprets — no command- or argument-injection surface.",
    code: `import subprocess


def git_show(ref: str) -> str:
    # argv list + shell=False (default): \`ref\` is one argument, never parsed by
    # a shell. The \`--\` guard stops a leading-dash \`ref\` from being read as a
    # flag. This is the safe alternative to os.system(f"git show {ref}").
    result = subprocess.run(
        ["git", "show", "--stat", "--", ref],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout
`,
  },
];

// Map a fixture to the synthetic filename the gate reviews. The extension
// nudges the models to read the snippet in the right language.
const EXT_BY_LANGUAGE: Readonly<Record<string, string>> = {
  rust: "rs",
  typescript: "ts",
  javascript: "js",
  solidity: "sol",
  bash: "sh",
  python: "py",
};

export function fixtureFilename(fixture: RegressionFixture): string {
  const ext = EXT_BY_LANGUAGE[fixture.language] ?? "txt";
  return `${fixture.id}.${ext}`;
}
