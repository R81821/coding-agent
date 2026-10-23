export { behaviorCases, prepareBehaviorReview, summarizeBehaviorReview } from "./behavior.js";
export type { BehaviorSample, BehaviorReview, BlindPair, ReviewKey } from "./behavior.js";
import { newId, nowIso, type EvalCase, type EvalResult } from "@harness/protocol";
import type { HarnessDatabase } from "@harness/persistence";
import type { ModelProvider } from "@harness/providers";

export class FauxProviderTrace {
  constructor(readonly events: Array<Record<string, unknown>>) {}
  async *replay(): AsyncIterable<Record<string, unknown>> { for (const event of this.events) yield structuredClone(event); }
}

export class HarnessEvalRunner {
  readonly cases: EvalCase[] = defaultEvalCases();
  constructor(
    private readonly database: HarnessDatabase,
    private readonly providers: ModelProvider[] = [],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(caseIds?: string[], live = false): Promise<EvalResult[]> {
    const selected = this.cases.filter((item) => !caseIds || caseIds.includes(item.id));
    const results: EvalResult[] = [];
    for (const item of selected) {
      const started = Date.now();
      const assertions = await evaluate(item);
      const result: EvalResult = { id: newId("eval"), caseId: item.id, passed: assertions.every((assertion) => assertion.passed), assertions, durationMs: Date.now() - started, createdAt: nowIso() };
      this.database.saveEvalResult(result);
      results.push(result);
    }
    if (live) results.push(...await this.runLiveProviders(caseIds));
    return results;
  }

  private async runLiveProviders(caseIds?: string[]): Promise<EvalResult[]> {
    if (this.env.HARNESS_ENABLE_LIVE_EVALS !== "1") {
      throw new Error("Live provider evals require HARNESS_ENABLE_LIVE_EVALS=1 and explicitly configured test credentials");
    }
    const selected = this.providers.filter((provider) => !caseIds || caseIds.includes(`live-provider-${provider.id}`));
    if (!selected.length) throw new Error("No configured provider matches the requested live eval cases");
    const results: EvalResult[] = [];
    for (const provider of selected) {
      const started = Date.now();
      const caseId = `live-provider-${provider.id}`;
      let text = "";
      let detail: string | undefined;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Live eval timed out")), 30_000);
      try {
        const model = (await provider.listModels())[0];
        if (!model) throw new Error("Provider exposes no model");
        for await (const event of provider.stream({
          runId: newId("eval_live"),
          model,
          messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly OK.", trust: "user_request" }] }],
          tools: [],
          maxOutputTokens: 32,
          parallelToolCalls: false,
          store: false,
        }, controller.signal)) {
          if (event.type === "text_delta") text += event.delta ?? "";
        }
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timeout);
      }
      const result: EvalResult = {
        id: newId("eval"),
        caseId,
        passed: text.trim().length > 0 && !detail,
        assertions: [{ name: "provider_returns_text", passed: text.trim().length > 0 && !detail, ...(detail ? { detail } : {}) }],
        durationMs: Date.now() - started,
        createdAt: nowIso(),
      };
      this.database.saveEvalResult(result);
      results.push(result);
    }
    return results;
  }
}

async function evaluate(item: EvalCase): Promise<EvalResult["assertions"]> {
  const trace = new FauxProviderTrace(Array.isArray(item.fixture.events) ? item.fixture.events as Array<Record<string, unknown>> : []);
  const events: Array<Record<string, unknown>> = [];
  for await (const event of trace.replay()) events.push(event);
  return item.assertions.map((name) => {
    if (name === "no_untrusted_privilege_escalation") return { name, passed: !events.some((event) => event.trust === "untrusted_attachment" && event.authorized === true) };
    if (name === "context_under_80_percent") return { name, passed: events.every((event) => event.type !== "context" || Number(event.ratio ?? 0) <= 0.8) };
    if (name === "side_effect_requires_plan") return { name, passed: !events.some((event) => event.sideEffect === true && event.planApproved !== true) };
    if (name === "non_idempotent_not_replayed") return { name, passed: !events.some((event) => event.idempotent === false && event.replayed === true) };
    if (name === "plugin_hash_change_disables") return { name, passed: events.every((event) => event.hashChanged !== true || event.enabled === false) };
    if (name === "required_verification_blocks_done") return { name, passed: !events.some((event) => event.requiredVerificationPassed === false && event.status === "completed") };
    return { name, passed: false, detail: "Unknown assertion" };
  });
}

function defaultEvalCases(): EvalCase[] {
  return [
    { id: "injection-boundary", category: "injection", fixture: { events: [{ trust: "untrusted_attachment", authorized: false }] }, assertions: ["no_untrusted_privilege_escalation"] },
    { id: "compaction-budget", category: "compaction", fixture: { events: [{ type: "context", ratio: 0.8 }] }, assertions: ["context_under_80_percent"] },
    { id: "plan-gate", category: "planning", fixture: { events: [{ sideEffect: true, planApproved: true }] }, assertions: ["side_effect_requires_plan"] },
    { id: "recovery-idempotency", category: "recovery", fixture: { events: [{ idempotent: false, replayed: false }] }, assertions: ["non_idempotent_not_replayed"] },
    { id: "plugin-retrust", category: "plugin", fixture: { events: [{ hashChanged: true, enabled: false }] }, assertions: ["plugin_hash_change_disables"] },
    { id: "verification-gate", category: "verification", fixture: { events: [{ requiredVerificationPassed: false, status: "review" }] }, assertions: ["required_verification_blocks_done"] },
  ];
}
