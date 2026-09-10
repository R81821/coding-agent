# Prompt cache optimization implementation plan

Goal: implement the seven requested cache improvements using Hermes as a read-only reference, preserving the existing workflow gates and prior fixes.

Architecture: immutable safety/coding prompt and canonical tools; bounded repository base snapshot; append-only runtime dirty diffs; provider-owned Responses continuation scoped to one run; provider-reported cache usage displayed per conversation turn.

References: Hermes agent/system_prompt.py (stable/context/volatile tiers), agent/coding_context.py (frozen workspace snapshot), agent/prompt_cache_scope.py (stable logical identity). Adapt these mechanisms to Harness tools; do not copy Hermes identity, permissions, tool names or mutable timestamps.

Global constraints: no real model calls for tests; preserve current user changes; never replay tools on continuation recovery; preserve permission checks, current revision verification and local persistence. previous_response_id uses server-stored Responses; expose an explicit Profile setting and preserve stateless mode when disabled.

- [x] Stable serialization, cache identity and bounded repository snapshot. Tests compare reordered schemas and repeated snapshots. Canonical JSON sorts object keys recursively, preserves array semantics, sorts tool contracts by name. Cache key derives from application version and normalized repository identity.
- [x] Stable system/coding prefix and append-only runtime state. Move workspace, budgets, recalled memories, project and skill context out of system prefix. Record base snapshot once, then dirty diffs; rebase on actual compaction. Tests compare exact successive request prefixes and reconstruct current runtime state.
- [x] Bounded code retrieval. Keep search_text as grep entry, lower read_file default and return actionable range guidance for truncation. Add read_range if absent. Tests verify line boundaries and bounds, confinement and compatible small-file output.
- [x] Responses continuation. Stable prompt_cache_key in OpenAI and compatible requests. Send only new input after a completed response; retain system instructions on every call. Start a fresh chain on changed history, model/tools or run, compaction, expired IDs or interrupted streams. Never chain a failed or incomplete response.
- [x] Cache telemetry and UI. Persist cachedInputTokens only when reported, normalize OpenAI/DeepSeek/Anthropic/Gemini counters, sum cached and eligible input tokens (never average ratios), distinguish unknown from zero, show coverage. Tests use captured wire requests and SSR UI rendering.
- [x] Run targeted tests, typecheck, complete test suite, lint and build; record actual results. Live hit rate remains unknown until a real user run reports server usage.

Validation (2026-09-10): 43 test files / 261 tests passed; typecheck, lint and full workspace build passed. Added continuation tests for function-call outputs, expired response IDs, changed instructions/model, failed/incomplete/EOF streams and stateless mode. Counted compaction model calls inside the existing 64-call budget. No live model usage or new installer. See docs/prompt-cache.md.
