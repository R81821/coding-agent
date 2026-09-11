# 1.4.0 audit completion plan

Baseline: 555230a (1.4.0-beta.3), clean tree. User authorized implementing the audit findings.

- [x] Runtime verification fingerprints, final code-state recheck, conservative unknown effects, requirement-specific independent review.
- [x] Analysis probe runs under a real read-only container boundary; unavailable sandbox returns configuration error, never host fallback. Auto/change retain permission-checked host execution.
- [x] Content-referenced checkpoints and outputs, indexed history, batched text persistence, staged validated backup-preserving migration.
- [x] Bounded context projections, preserve decisions/completed tasks during compaction, enforce post-compaction budget, content-validated read reuse.
- [x] Desktop task mode/protocol controls, accurate purpose/cache/cost/status/timing display, configurable model capacity.
- [x] Review, regression, typecheck, lint, build; no real model calls or live user-data migration during tests.

Interfaces: controller owns protocol/core/tools; storage implementer owns persistence; desktop implementer follows stable protocol fields after storage task. All changes keep session IDs, existing grants and legacy reads. 64 model calls / 128 tools / unlimited repairs remain.
Ruling: arbitrary analysis scripts require Docker with read-only repository mount, no network, no capabilities, a preinstalled image. Merely changing cwd does not meet the approved read-only requirement. Never auto-download images or fall back to a host shell.
Ruling: unknown coverage remains unknown. File hashing caches use content checks for reused reads; unknown commands remain conservatively checked across workspace.
Ruling: independent review must check every user requirement for change tasks, including small edits; analysis does not gain a fixed extra model call.

Validation completed 2026-09-11: 57 files / 331 tests; typecheck, lint, build, package runtime and isolated daemon health pass. Independent review findings fixed and rechecked. Installer remains unsigned. Live model performance, real Docker integration, manual UI acceptance and physical fault injection remain unmeasured; see ../../releases/1.4.0.md.
