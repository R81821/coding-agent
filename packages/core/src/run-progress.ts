import { createHash } from "node:crypto";
import type { ToolCall } from "@harness/protocol";
import type { ToolDefinition, ToolResult } from "@harness/tools";

const RECON_TOOLS = new Set(["read_file", "list_files", "search_text", "git_diff"]);

/** Bounded runtime observations; raw output remains in the audited transcript. */
export class RunProgress {
  private readonly repetitions = new Map<string, { digest: string; count: number }>();
  private readonly observations: Array<{ tool: string; target: string; failed: boolean; repeats: number }> = [];

  invalidate(): void { this.repetitions.clear(); }

  record(call: ToolCall, tool: ToolDefinition, result: ToolResult): string | undefined {
    const target = JSON.stringify(call.input).slice(0, 240);
    let repeats = 1;
    if (RECON_TOOLS.has(call.name) && tool.contract.idempotent) {
      const input = JSON.stringify(Object.fromEntries(Object.entries(call.input).sort(([a], [b]) => a.localeCompare(b))));
      const key = `${call.name}:${input}`;
      const digest = createHash("sha256").update(JSON.stringify(result.output) ?? "undefined").digest("hex");
      const previous = this.repetitions.get(key);
      repeats = previous?.digest === digest ? previous.count + 1 : 1;
      this.repetitions.set(key, { digest, count: repeats });
    }
    this.observations.push({ tool: call.name, target, failed: result.isError === true, repeats });
    if (this.observations.length > 12) this.observations.shift();
    return repeats >= 3 ? `${call.name} 对相同参数连续获得相同结果，已停止重复探索。` : undefined;
  }

  snapshot() { return this.observations.slice(); }

  fallback(): string {
    const items = this.observations.map((item) => `- ${item.tool} ${item.target}：${item.failed ? "失败，尚未解决" : "已取得结果"}`);
    return ["本轮尚未完成，已保留工具结果供复核。", ...items, "上述记录只说明已执行的操作，不代表代码分析、修复或验证已经完成。"].join("\n");
  }
}
