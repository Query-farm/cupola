---
paths:
  - "src/lib/ai/**"
  - "src/lib/ai-*.ts"
  - "src/lib/shell-ai-mode.ts"
  - "src/components/AskAIChat.tsx"
  - "src/components/chat/**"
  - "src/lib/evidence/agent*.ts"
  - "src/lib/pricing.ts"
  - "tests/unit/ai-*.test.ts"
---

# AI agent: prompt caching and thinking

## Prompt caching (`ai-agent.ts`): byte-stable prefix
- Render order `tools` → `system` → `messages`; any changed byte invalidates everything after it. Breaks are **silent** (just a higher bill).
- Breakpoints: top-level `cache_control` (advances with the tail), one on the **last** tool of whatever set was passed (never a fixed index), one per `cacheControl` system block. Reports path uses all four slots; a fifth is a 400.
- **Nothing mutable in `system`.** Mutable state goes in the trailing user turn: the report draft directly, memory-catalog drift via `ai/memory-context.ts`. Chat panel, editor AI panel and `.ai` share `ai/frozen-prompt.ts`, which rebuilds only when a non-memory catalog's metadata or the query mode changes.
- **History is append-only** (newer models also reject edited history with signed thinking). Earlier report snapshots keep their values ("at the start of this turn"). Sanctioned exceptions, no-ops normally:
  - `sanitizeConversation` (repairs a broken history only).
  - `pruneCarriedToolImages`, gated by `shouldPruneCarriedImages` to past half of `modelContextWindow` (`ai/model-limits.ts`); sheds all carried images at once (one break). Never prune per round. The estimator prices images as images, not base64 text.
- Guard: `tests/unit/ai-agent-cache.test.ts` asserts the earlier request's rendered prompt reappears **unedited** as a prefix of the later one (`cache_control` stripped).
- Diagnosis: `window.__cupolaAiCacheDiagnostics = true` (`cache-diagnosis-2026-04-07`) names where two requests diverged. Chat and `.ai` show per-turn hit rate.

## Thinking (`src/lib/ai/model-features.ts`)
- Omitted `thinking` = none on Sonnet 4.6 / Haiku 4.5, but adaptive on Opus 5 / Sonnet 5. Always send the field explicitly (or deliberately not at all); never rely on a model default.
- **`thinking`/`redacted_thinking` blocks must round-trip verbatim** (signed; a turn missing them is rejected and wedges the conversation). The SSE parser keeps them; `dropToolUseFromLastAssistant` (cancel path) strips only the unmatched `tool_use`.
- `display: "summarized"` only on surfaces that pass `onThinking`; others keep the default `"omitted"`. Same billing. `EvidenceAgent` shows a streaming `reasoning` block, folded to its first line (Markdown) afterwards.
