# Provider fixtures

These JSON files are **synthetic recordings** that mirror the shape of real Anthropic
Messages API and OpenAI Chat Completions API responses. They are used by the unit tests
in `src/providers/*.test.ts` to verify response parsing without spending tokens or
needing a network connection.

Each fixture is hand-crafted to match the SDK type contract:

- `anthropic-review-*.json` — `Anthropic.Messages.Message` shape, with a `tool_use`
  content block that calls the `submit_review` tool. The `input` field carries the
  same JSON the real API would return when the model is constrained to
  `reviewJsonSchema`.
- `openai-review-*.json` — `OpenAI.Chat.Completions.ChatCompletion` shape, with the
  `message.content` field carrying the structured JSON the real API would return
  when constrained to `reviewJsonSchema` via `response_format`.

When refreshing these fixtures from real API responses:

1. Run the provider against a small repo with both `ANTHROPIC_API_KEY` and
   `OPENAI_API_KEY` set.
2. Capture the raw response object (not the parsed `ReviewOutput`).
3. **Redact** any prompts, source code quotes, or org-identifying metadata before
   saving — including `id`, `usage`, `model`, and any user-visible strings that
   leak project context. The fixtures here use synthetic but realistic content.
4. Commit. Tests should still pass.

The fixtures are intentionally minimal: the goal is to exercise the response-shape
parsing layer in `extractAnthropicToolOutput` and `extractOpenAIContent`, not to
benchmark real model behavior.
