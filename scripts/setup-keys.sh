#!/usr/bin/env bash
# scripts/setup-keys.sh — interactive API key intake for Antfeed Fleet.
#
# Reads ANTHROPIC_API_KEY, OPENAI_API_KEY, and OPENROUTER_API_KEY from the
# terminal, validates rough shape, and writes them to .env.local with mode 600.
# Press Enter at any prompt to skip a key (useful if one is already exported in
# your shell).
#
# Two input modes:
#   (default)         silent input via stty -echo. Most secure, but macOS
#                     Terminal / iTerm typically block clipboard paste at
#                     no-echo prompts as a security feature.
#   --echo | -e       echo input as it is typed. Paste works. Trade-off: the
#                     key is visible on your local screen and in scrollback.
#                     Use this when you need to paste a key and you trust your
#                     local terminal session.
#
# The script never echoes the saved value back at the end and never commits
# the keys -- .env.local is gitignored.

set -euo pipefail

ECHO_MODE=0
for arg in "$@"; do
  case "$arg" in
    --echo|-e) ECHO_MODE=1 ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      echo "usage: bash scripts/setup-keys.sh [--echo]" >&2
      exit 2
      ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"

if [[ ! -t 0 ]]; then
  echo "setup-keys.sh requires an interactive terminal (stdin is not a TTY)." >&2
  echo "Re-run this from your shell:  bash scripts/setup-keys.sh [--echo]" >&2
  exit 2
fi

echo
echo "This will save API keys to .env.local (mode 600, gitignored)."
if (( ECHO_MODE == 1 )); then
  echo "Mode: --echo  (input is VISIBLE on your screen and in scrollback)."
  echo "      Paste works. Close the window or 'clear' the scrollback when done."
else
  echo "Mode: silent  (input is hidden; macOS Terminal may block clipboard paste)."
  echo "      Re-run with --echo to enable paste at the cost of on-screen visibility."
fi
read -rp "Are you sure you want to enter API keys? (y/N) " confirm
case "${confirm:-}" in
  y|Y|yes|YES) ;;
  *) echo "Aborted; no keys saved."; exit 0;;
esac

# read_value VARNAME
# Reads one line from /dev/tty into VARNAME. Echo behavior depends on the
# global ECHO_MODE: silent (stty -echo) by default, visible with --echo.
read_value() {
  local __varname="$1" __value=""
  local saved
  saved=$(stty -g 2>/dev/null || true)
  if (( ECHO_MODE == 0 )); then
    stty -echo 2>/dev/null || true
    printf '\e[?2004l' > /dev/tty 2>/dev/null || true
  fi
  IFS= read -r __value < /dev/tty || __value=""
  if (( ECHO_MODE == 0 )); then
    printf '\e[?2004h' > /dev/tty 2>/dev/null || true
    if [[ -n "$saved" ]]; then
      stty "$saved" 2>/dev/null || stty echo 2>/dev/null || true
    else
      stty echo 2>/dev/null || true
    fi
    printf "\n" > /dev/tty
  fi
  printf -v "$__varname" '%s' "$__value"
}

# prompt_key NAME REGEX HELP
# Up to 3 retries on shape mismatch. Empty input means "skip this key".
prompt_key() {
  local name="$1" regex="$2" help="$3" value
  local attempts=0
  while (( attempts < 3 )); do
    printf "%s (Enter to skip; %s): " "$name" "$help" > /dev/tty
    read_value value
    if [[ -z "$value" ]]; then
      printf "  -> skipped\n" > /dev/tty
      return 0
    fi
    if [[ "$value" =~ $regex ]]; then
      printf "  -> accepted (length=%d)\n" "${#value}" > /dev/tty
      printf "%s" "$value"
      return 0
    fi
    attempts=$((attempts + 1))
    printf "  -> shape mismatch (expected: %s); retry (%d/3)\n" "$help" "$attempts" > /dev/tty
  done
  printf "  -> too many invalid attempts; skipping\n" > /dev/tty
  return 0
}

ANTHROPIC_VALUE=$(prompt_key "ANTHROPIC_API_KEY" '^sk-ant-[A-Za-z0-9_-]+$' 'sk-ant-…')
OPENAI_VALUE=$(prompt_key "OPENAI_API_KEY" '^sk-[A-Za-z0-9_-]+$' 'sk-…')
OPENROUTER_VALUE=$(prompt_key "OPENROUTER_API_KEY" '^sk-or-[A-Za-z0-9_-]+$' 'sk-or-…')

# Create the file with restrictive perms BEFORE writing any secrets.
umask 077
: > "$ENV_FILE"
chmod 600 "$ENV_FILE"

saved=0
write_key() {
  local name="$1" value="$2"
  if [[ -n "$value" ]]; then
    printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
    saved=$((saved + 1))
  fi
}

write_key "ANTHROPIC_API_KEY" "$ANTHROPIC_VALUE"
write_key "OPENAI_API_KEY" "$OPENAI_VALUE"
write_key "OPENROUTER_API_KEY" "$OPENROUTER_VALUE"

# Ensure restrictive perms again (umask only affects creation).
chmod 600 "$ENV_FILE"

if (( saved == 0 )); then
  echo "No keys provided; .env.local is empty. Re-run if you want to populate it." >&2
  exit 1
fi

echo "Saved $saved keys to .env.local"
if (( ECHO_MODE == 1 )); then
  echo "Reminder: --echo mode left your keys visible on this terminal. Run 'clear' or close the window."
fi
