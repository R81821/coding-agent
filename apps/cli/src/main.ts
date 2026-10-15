#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { AgentEvent, AttachmentRef, Profile, RunSteerResult } from "@harness/protocol";
import { newId, nowIso } from "@harness/protocol";
import { daemonRequest, PIPE_PATH } from "./client.js";

const [command = "chat", ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "doctor": await doctor(); break;
    case "run": await startRun(args.join(" "), []); break;
    case "resume": await resume(args[0]); break;
    case "pause": await pause(args[0]); break;
    case "steer": await steer(args[0], args.slice(1).join(" ")); break;
    case "chat": await chat(); break;
    case "tasks":
    case "cron": console.log(JSON.stringify(await daemonRequest({ method: "tasks.list" }), null, 2)); break;
    case "profiles": console.log(JSON.stringify(await daemonRequest({ method: "profiles.list" }), null, 2)); break;
    case "skills": console.log(JSON.stringify(await daemonRequest({ method: "skills.list" }), null, 2)); break;
    case "memory": await manageMemory(args); break;
    case "plugins": console.log(JSON.stringify(await daemonRequest({ method: "plugins.list" }), null, 2)); break;
    case "search": console.log(JSON.stringify(await daemonRequest({ method: "search.status" }), null, 2)); break;
    case "eval": {
      const live = args.includes("--live");
      const caseIds = args.filter((arg) => arg !== "--live");
      console.log(JSON.stringify(await daemonRequest({ method: "eval.run", params: { live, ...(caseIds.length ? { caseIds } : {}) } }), null, 2));
      break;
    }
    case "trace": console.log(JSON.stringify(await daemonRequest({ method: "trace.query", params: { ...(args[0] ? { runId: args[0] } : {}), limit: 200 } }), null, 2)); break;
    case "gateway": console.log(JSON.stringify(await daemonRequest({ method: "health" }), null, 2)); break;
    case "help":
    case "--help":
    case "-h": printHelp(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function doctor(): Promise<void> {
  const result = await daemonRequest<Record<string, unknown>>({ method: "health" });
  console.log(`daemon: ok (${PIPE_PATH})`);
  console.log(`version: ${String(result.version)}`);
  const configured = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"].filter((key) => process.env[key]);
  console.log(`providers in CLI environment: ${configured.length ? configured.join(", ") : "not visible; daemon may have its own configuration"}`);
}

async function manageMemory(args: string[]): Promise<void> {
  const [action = "list", id, ...rest] = args;
  if (action === "list") {
    console.log(JSON.stringify(await daemonRequest({ method: "memory.list", ...(id ? { params: { scopeId: id } } : {}) }), null, 2));
    return;
  }
  if (action === "export") {
    if (!id) throw new Error("Usage: harness-agent memory export <id> [id ...] (JSON to stdout)");
    console.log(JSON.stringify(await daemonRequest({ method: "memory.export", params: { memoryIds: [id, ...rest] } }), null, 2));
    return;
  }
  if (!id) throw new Error("Usage: harness-agent memory <edit|pin|unpin|expire|delete|approve|reject> <id> [content / ISO time / never]");
  if (action === "delete") {
    console.log(await daemonRequest({ method: "memory.delete", params: { memoryId: id } }));
    return;
  }
  if (action === "approve" || action === "reject") {
    console.log(await daemonRequest({ method: "memory.decide", params: { memoryId: id, approved: action === "approve", actor: "cli:user" } }));
    return;
  }
  const patch = action === "edit" ? { content: rest.join(" ") }
    : action === "pin" || action === "unpin" ? { pinned: action === "pin" }
    : action === "expire" && rest[0] ? { expiresAt: rest[0] === "never" ? null : rest[0] }
    : undefined;
  if (!patch) throw new Error("Unknown memory action or missing expiry; use edit, pin, unpin, expire, delete, approve, reject, export, or list");
  console.log(JSON.stringify(await daemonRequest({ method: "memory.update", params: { memoryId: id, patch, actor: "cli:user" } }), null, 2));
}

async function chat(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, historySize: 200 });
  const attachments: AttachmentRef[] = [];
  let profileId = "default";
  console.log("Harness Agent interactive TUI. /help shows commands.");
  try {
    while (true) {
      const line = (await rl.question("harness> ")).trim();
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/help") { printSlashHelp(); continue; }
      if (line.startsWith("/attach ")) {
        const attachment = await uploadAttachment(line.slice(8).trim());
        attachments.push(attachment);
        console.log(`attached ${attachment.mimeType} ${attachment.sha256.slice(0, 12)}…; it remains untrusted data`);
        continue;
      }
      if (line.startsWith("/profile ")) { profileId = line.slice(9).trim(); console.log(`profile=${profileId}`); continue; }
      if (line === "/model") { console.log("Model is selected automatically from the active profile and run capabilities."); continue; }
      if (line === "/compact") { console.log("Context compaction is automatic at provider limits; persistent memory requires approval."); continue; }
      if (line.startsWith("/cancel ")) { console.log(await daemonRequest({ method: "run.cancel", params: { runId: line.slice(8).trim() } })); continue; }
      const prompt = line.startsWith("/delegate ") ? `Delegate independent subtasks where safe, then integrate the results: ${line.slice(10)}` : line;
      await startRun(prompt, attachments.splice(0), profileId, rl);
    }
  } finally {
    rl.close();
  }
}

async function startRun(prompt: string, attachments: AttachmentRef[], profileId = "default", existingRl?: ReturnType<typeof createInterface>): Promise<void> {
  if (!prompt.trim()) throw new Error("A prompt is required");
  const profiles = await daemonRequest<Profile[]>({ method: "profiles.list" });
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) throw new Error(`Unknown profile: ${profileId}`);
  const runId = newId("run");
  await daemonRequest({
    method: "run.start",
    params: {
      id: runId,
      sessionId: newId("session"),
      request: prompt,
      workspacePath: process.cwd(),
      profileId,
      attachments,
      budget: profile.budget,
      grants: [],
      createdAt: nowIso()
    }
  });
  console.log(`run ${runId}`);
  await follow(runId, existingRl);
}

async function resume(runId?: string): Promise<void> {
  if (!runId) throw new Error("resume requires a run id");
  const result = await daemonRequest<{ runId: string }>({ method: "run.resume", params: { runId } });
  console.log(`resumed as ${result.runId}`);
  await follow(result.runId);
}

/** Ask an active run to stop at its next turn boundary, keeping everything needed to resume it. */
async function pause(runId?: string): Promise<void> {
  if (!runId) throw new Error("pause requires a run id");
  const result = await daemonRequest<{ pausing: boolean }>({ method: "run.pause", params: { runId } });
  console.log(result.pausing ? `pause requested for ${runId}; it stops at the next turn boundary` : `run ${runId} is not active`);
}

/**
 * Hand an active run a correction it will read at its next turn boundary. The run keeps its
 * transcript and budget, so this steers the work in progress instead of starting a new task.
 */
async function steer(runId: string | undefined, text: string): Promise<void> {
  if (!runId || !text.trim()) throw new Error("steer requires a run id and a message: steer <run-id> <message>");
  const result = await daemonRequest<RunSteerResult>({ method: "run.steer", params: { runId, text } });
  if (!result.accepted) throw new Error(`Run ${runId} is ${result.status}; the steering message was not accepted`);
  console.log(`queued steering message ${result.queued} for ${runId}; ${result.status === "paused" ? "it is retained until this run resumes" : "it is delivered at the next turn boundary"}`);
}

async function follow(runId: string, existingRl?: ReturnType<typeof createInterface>): Promise<void> {
  let sequence = -1;
  let done = false;
  // While this loop is running the prompt is busy, so pause/steer are consumed here rather than at
  // the outer prompt. Approval questions keep their own line listener and are unaffected.
  const onLine = (line: string) => {
    const value = line.trim();
    void (async () => {
      try {
        if (value === "/pause") await pause(runId);
        else if (value === "/resume") await resume(runId);
        else if (value.startsWith("/steer ")) await steer(runId, value.slice(7));
      } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    })();
  };
  existingRl?.on("line", onLine);
  try {
  while (!done) {
    const events = await daemonRequest<AgentEvent[]>({ method: "run.events", params: { runId, afterSequence: sequence } });
    for (const event of events) {
      sequence = Math.max(sequence, event.sequence);
      if (event.type === "text_delta") stdout.write(event.delta);
      if (event.type === "route") console.log(`\n[route] ${event.providerId}/${event.modelId}: ${event.reason}; estimated $${event.estimatedUsd.toFixed(4)}`);
      if (event.type === "status") console.log(`\n[${event.status}]`);
      if (event.type === "tool_started") console.log(`[tool] ${event.call.name}`);
      if (event.type === "approval_required") {
        const ownRl = existingRl ?? createInterface({ input: stdin, output: stdout });
        const answer = (await ownRl.question(`\nApproval required: ${event.summary}\nApprove once? [y/N] `)).trim().toLowerCase();
        if (!existingRl) ownRl.close();
        await daemonRequest({ method: "approval.decide", params: { approvalId: event.approvalId, approved: answer === "y" || answer === "yes", actor: "cli:user" } });
      }
      if (event.type === "plan_approval_required") {
        const ownRl = existingRl ?? createInterface({ input: stdin, output: stdout });
        const answer = (await ownRl.question(`\nPlan approval required (v${event.version}):\n${event.summary}\nApprove? [y/N, or type feedback] `)).trim();
        if (!existingRl) ownRl.close();
        const approved = ["y", "yes"].includes(answer.toLowerCase());
        await daemonRequest({ method: "plan.decide", params: { planId: event.planId, version: event.version, approved, actor: "cli:user", ...(!approved && answer && !["n", "no"].includes(answer.toLowerCase()) ? { feedback: answer } : {}) } });
      }
      if (event.type === "error") console.error(`\n[${event.code}] ${event.message}`);
      if (event.type === "result") { console.log(`\n[result:${event.status}]`); done = true; }
    }
    if (!done) await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  }
  } finally { existingRl?.off("line", onLine); }
}

async function uploadAttachment(pathInput: string): Promise<AttachmentRef> {
  const path = resolve(pathInput);
  const bytes = await readFile(path);
  const mimeType = mimeFromPath(path);
  console.log(`Will send ${path} to the vision-capable provider selected for this run.`);
  return daemonRequest<AttachmentRef>({ method: "attachment.put", params: { base64: bytes.toString("base64"), mimeType, source: "file", allowedProviders: [] } }, 60_000);
}

function mimeFromPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    default: throw new Error("Only PNG, JPEG, GIF, and WebP images are supported");
  }
}

function printHelp(): void {
  console.log("harness-agent <chat|run|resume|pause|steer|tasks|cron|profiles|skills|memory|plugins|search|eval|trace|gateway|doctor>");
  console.log("  pause <run-id>              stop an active run at its next turn boundary, keeping it resumable");
  console.log("  steer <run-id> <message>    send a correction that the active run reads at its next turn boundary");
}

function printSlashHelp(): void {
  console.log("/attach PATH  /profile ID  /model  /delegate PROMPT  /cancel RUN_ID  /compact  /exit");
  console.log("While a run is active: /pause  /resume  /steer MESSAGE");
}
