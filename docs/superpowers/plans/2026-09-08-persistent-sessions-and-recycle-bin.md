# Persistent Sessions and Recycle Bin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a desktop conversation reuse one persistent Session across messages, create Sessions only from explicit UI actions, and add recoverable Session/project deletion with Session-only permanent deletion that preserves memory.

**Architecture:** Add encrypted first-class Session and project records while retaining one run per user message. The daemon reconstructs bounded prior Session turns for every new run, and the renderer groups Session summaries under projects instead of treating each run as a conversation. Soft deletion is metadata-only; Session purge removes run-owned records in a fixed database transaction and deliberately excludes memory tables.

**Tech Stack:** TypeScript, Zod protocol schemas, encrypted sql.js persistence, Electron IPC, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-08-persistent-sessions-and-recycle-bin-design.md`

## Global Constraints

- Only “新建任务” and a project-row `+` create Sessions; sending, startup, profile changes, and project expansion never create one.
- Every user message creates a new run with the active Session ID; run budgets, approvals, checkpoints, and `CodingWorkflow` remain per-message.
- Removing a project never reads, writes, moves, or deletes the workspace directory.
- Session/project soft deletion is reversible in Settings; only deleted Sessions offer permanent deletion.
- Session deletion, restoration, and purge never delete or alter `memories` or `memory_search`.
- Existing run history migrates without loss; each legacy `sessionId` becomes a Session.
- One Session may have at most one live run.

---

### Task 1: Session and project persistence

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/persistence/src/database.ts`
- Modify: `tests/run-history.test.ts`

**Interfaces:**
- Produces: `SessionRecord`, `ProjectRecord`, `SessionSummary`, `SessionDetail`, `SessionPage`.
- Produces: `HarnessDatabase.createSession`, `listSessions`, `getSessionDetail`, `deleteSession`, `restoreSession`, `purgeSession`, `ensureProject`, `listProjects`, `deleteProject`, `restoreProject`, `touchSession`.
- `purgeSession(sessionId)` returns deletion counts and never calls memory deletion.

- [ ] **Step 1: Write failing persistence tests**

Add tests that create an empty Session, append two runs with the same Session ID, reopen the encrypted database, and assert stable title/activity/order. Add soft-delete/restore tests for Session and project. Add a purge test that saves run events, plans, checkpoints, compactions, verification runs, approvals, traces and a Session-scoped memory; assert all run-owned records disappear while `listMemories()` and `searchMemories()` still return the memory.

- [ ] **Step 2: Run persistence tests and verify RED**

Run: `node node_modules/vitest/vitest.mjs run tests/run-history.test.ts`

Expected: FAIL because Session/project schemas and database methods do not exist.

- [ ] **Step 3: Add protocol records and database tables**

Define records with stable IDs, `workspacePath`, `profileId`, title, timestamps and optional `deletedAt`. Add encrypted generic `sessions` and `projects` tables. In migration, decrypt existing runs, create one Session per distinct legacy `sessionId`, and create one project per normalized workspace path. Do not rewrite run payloads.

- [ ] **Step 4: Implement lifecycle methods and fixed purge transaction**

Make lists exclude deleted rows by default and accept `deleted: true` for recycle-bin queries. Reject deletion while a related run has a live status. Purge a Session by resolving run IDs server-side and deleting only their events, plans, checkpoints, compactions, verification runs, approvals, traces and run rows, then the Session row. Keep memories and their search index outside the transaction.

- [ ] **Step 5: Run persistence tests and verify GREEN**

Run: `node node_modules/vitest/vitest.mjs run tests/run-history.test.ts tests/persistence.test.ts tests/memory.test.ts`

Expected: PASS, including encrypted reopen and memory-preservation assertions.

- [ ] **Step 6: Commit Task 1**

Run: `git add packages/protocol/src/index.ts packages/persistence/src/database.ts tests/run-history.test.ts && git commit -m "feat: persist sessions and project recycle state"`

### Task 2: Persistent conversation context and daemon lifecycle

**Files:**
- Create: `packages/core/src/session-context.ts`
- Modify: `packages/core/src/engine.ts`
- Modify: `apps/daemon/src/main.ts`
- Modify: `packages/protocol/src/index.ts`
- Test: `tests/session-context.test.ts`
- Test: `tests/engine.test.ts`

**Interfaces:**
- Consumes: `HarnessDatabase.getSessionDetail(sessionId)` and Session lifecycle methods from Task 1.
- Produces: `buildSessionContext(detail, currentRunId, maxChars)` returning trusted-role message structures whose historical contents retain untrusted user/tool trust labels.
- Produces daemon methods `sessions.create`, `sessions.list`, `session.get`, `session.delete`, `session.restore`, `session.purge`, `projects.list`, `project.delete`, and `project.restore`.

- [ ] **Step 1: Write failing context and daemon tests**

Create two Sessions with multiple runs. Assert the second run receives the first run's user request and final result in order, excludes another Session, marks interrupted runs as incomplete, and trims oldest turns when the character budget is exceeded. Assert `run.start` rejects missing/deleted Sessions, deleted projects, mismatched workspace paths, and a second live run.

- [ ] **Step 2: Run tests and verify RED**

Run: `node node_modules/vitest/vitest.mjs run tests/session-context.test.ts tests/engine.test.ts`

Expected: FAIL because no Session context builder or lifecycle requests exist.

- [ ] **Step 3: Implement bounded Session context**

Read prior runs in stable creation order. Pair each request with its final `result` event; represent unfinished runs with an explicit incomplete marker. Preserve recent turns verbatim and summarize older turns within `maxChars`. Insert the history below current system/Profile policy and above the new user request, without converting historical user text into trusted instructions.

- [ ] **Step 4: Validate Session on run start and maintain activity**

At daemon `run.start`, require an existing visible Session and project with the same normalized workspace path, reject another live run, then start the engine. Touch Session title/activity when the run is saved and when its terminal status is written. Ensure remote connector chats create their stable Session/project records on first message.

- [ ] **Step 5: Add lifecycle request schemas and dispatch**

Use fixed discriminated-union request members with ID/path schemas. Return Session pages/details rather than raw database rows. Keep project deletion metadata-only.

- [ ] **Step 6: Run context and engine tests and verify GREEN**

Run: `node node_modules/vitest/vitest.mjs run tests/session-context.test.ts tests/engine.test.ts tests/run-history.test.ts`

Expected: PASS; fake providers show only same-Session history in the model request.

- [ ] **Step 7: Commit Task 2**

Run: `git add packages/core/src/session-context.ts packages/core/src/engine.ts apps/daemon/src/main.ts packages/protocol/src/index.ts tests/session-context.test.ts tests/engine.test.ts && git commit -m "feat: continue runs with persistent session context"`

### Task 3: Renderer IPC and Session-oriented state

**Files:**
- Modify: `apps/desktop/src/renderer-ipc.ts`
- Modify: `apps/desktop/src/run-history.ts`
- Modify: `apps/desktop/src/assistant-messages.ts`
- Modify: `apps/desktop/src/renderer.tsx`
- Test: `tests/renderer-ipc.test.ts`
- Test: `tests/run-history.test.ts`

**Interfaces:**
- Consumes daemon lifecycle methods and `SessionPage`/`SessionDetail` from Task 2.
- Produces `groupSessionsByProject`, `sessionTurns`, and renderer state `activeSessionId`, `activeRunId`, `sessionDetail`.

- [ ] **Step 1: Write failing renderer-state tests**

Assert the IPC whitelist permits only the declared Session/project lifecycle methods. Assert grouping uses Session summaries, status comes from the latest run, multi-run events remain separated by run ID, and two messages in one Session produce two visible user/assistant turns.

- [ ] **Step 2: Run tests and verify RED**

Run: `node node_modules/vitest/vitest.mjs run tests/renderer-ipc.test.ts tests/run-history.test.ts`

Expected: FAIL because the renderer still groups runs and exposes one submitted prompt.

- [ ] **Step 3: Replace run-history state with Session state**

Load visible Sessions and projects after unlock. Persist the last active Session ID in local storage; restore it only if still visible, otherwise choose the current-project or global newest Session. Opening a Session fetches all its runs/events. Poll only the current live run and merge the result back into that Session detail.

- [ ] **Step 4: Reuse active Session when sending**

Require `activeSessionId`. Generate only a run ID, pass the stable Session ID to `run.start`, append a pending turn locally, and retain prior turns. After completion refresh Session metadata without clearing the conversation.

- [ ] **Step 5: Render multiple turns**

Update `ChatView` to map Session turns into user message plus run event output. Keep workflow progress, approvals, streaming Markdown and copy actions scoped to their run. Existing single-run histories must render unchanged after migration.

- [ ] **Step 6: Run renderer-state tests and verify GREEN**

Run: `node node_modules/vitest/vitest.mjs run tests/renderer-ipc.test.ts tests/run-history.test.ts apps/desktop/src/markdown-message.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

Run: `git add apps/desktop/src/renderer-ipc.ts apps/desktop/src/run-history.ts apps/desktop/src/assistant-messages.ts apps/desktop/src/renderer.tsx tests/renderer-ipc.test.ts tests/run-history.test.ts && git commit -m "feat: render persistent multi-turn sessions"`

### Task 4: Explicit creation, soft-delete controls, and Settings recycle bin

**Files:**
- Create: `apps/desktop/src/recycle-bin.tsx`
- Modify: `apps/desktop/src/renderer.tsx`
- Modify: `apps/desktop/src/workbench.css`
- Modify: `apps/desktop/scripts/history-smoke.cjs`

**Interfaces:**
- Consumes Session/project lifecycle IPC from Task 2 and state from Task 3.
- Produces `RecycleBin` component with restore and Session purge actions.

- [ ] **Step 1: Extend the real Electron smoke fixture and verify RED**

Add fixture IPC storage for Sessions/projects and checks that: ordinary sends reuse a Session; top-level “新建任务” and project `+` create exactly one Session each; Session/project trash buttons do not select/collapse their parent; deleted items disappear from the sidebar; Settings shows both recycle lists; restoring returns them; only a deleted Session has a permanent-delete button; permanent deletion leaves fixture memories unchanged.

Run after a current build: hidden Electron with `apps/desktop/scripts/history-smoke.cjs`.

Expected: FAIL on the first missing Session-oriented selector or lifecycle request.

- [ ] **Step 2: Implement the two explicit creation actions**

Top-level “新建任务” creates an empty Session in the current workspace, selecting a workspace first when absent. Project-row `+` creates an empty Session directly under that project. Opening a new repository ensures/restores its project record and creates one empty Session. No other handler calls `sessions.create`.

- [ ] **Step 3: Add row-level delete controls**

Use stop-propagation on Session/project delete buttons. Confirm Session soft deletion is restorable and memory-preserving. Confirm project deletion only hides it in Harness and never touches files. Surface daemon refusal for live runs without mutating current UI state.

- [ ] **Step 4: Add Settings recycle bin**

Load deleted Sessions/projects only while Settings is visible or refreshed. Restore actions refresh sidebar and recycle data. Session purge uses a second explicit confirmation stating that chat/run history is irreversible while memory remains. Deleted projects have restore only.

- [ ] **Step 5: Style and run Electron smoke to verify GREEN**

Run the workspace build, then the isolated hidden Electron smoke fixture. Inspect captured sidebar and Settings screenshots for button visibility, hierarchy, overflow and Chinese copy.

Expected: all prior UI checks plus new Session/recycle checks PASS; no real database, model, network or workspace deletion is used.

- [ ] **Step 6: Commit Task 4**

Run: `git add apps/desktop/src/recycle-bin.tsx apps/desktop/src/renderer.tsx apps/desktop/src/workbench.css apps/desktop/scripts/history-smoke.cjs && git commit -m "feat: add session and project recycle controls"`

### Task 5: Documentation and release verification

**Files:**
- Modify: `README.md`
- Create: `docs/session-lifecycle.md`
- Modify: relevant package version files only if producing a release installer.

**Interfaces:**
- Consumes all previous tasks.
- Produces user-facing lifecycle documentation and verification evidence.

- [ ] **Step 1: Document lifecycle and deletion guarantees**

Describe explicit Session creation, one-run-per-message execution, context reconstruction, restart behavior, soft-delete recovery, Session purge scope and the invariant that project deletion never touches disk and Session deletion never touches memory.

- [ ] **Step 2: Run fresh full verification**

Run:

```text
node node_modules/vitest/vitest.mjs run
node node_modules/typescript/bin/tsc --noEmit
node node_modules/eslint/bin/eslint.js .
git diff --check
node <pnpm-entry> -r --if-present run build
```

Expected: zero failures. Then rerun the real Electron Session/recycle smoke and inspect both screenshots.

- [ ] **Step 3: Review database and memory boundaries**

Inspect the staged diff and verify no Session/project delete path accepts a filesystem deletion target, no purge statement includes `memories` or `memory_search`, and all new renderer mutation methods are explicit IPC allowlist entries.

- [ ] **Step 4: Commit Task 5**

Run: `git add README.md docs/session-lifecycle.md && git commit -m "docs: describe persistent session lifecycle"`

- [ ] **Step 5: Package only when requested for this implementation**

If the user requests an installer, bump the release version consistently, rebuild, create the Windows x64 NSIS installer, run the packaged-code/native-dependency smoke test, calculate SHA-256, and write a release manifest tied to the exact Git commit.
