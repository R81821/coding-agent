import React, { useEffect, useState } from "react";
import type { Profile } from "@harness/protocol";
import { BuiButton } from "../ui/button.js";
import { BuiGlassPanel } from "../ui/card.js";

export function profileWithVerificationInputs(profile: Profile, commands: string, broaderCommands: string, broaderPolicy: "required" | "optional" | "disabled"): Profile {
  const items = ([{ stage: "local" as const, text: commands }, { stage: "broader" as const, text: broaderCommands }])
    .flatMap(group => group.text.split(/\r?\n/).map(command => command.trim()).filter(Boolean).map(command => ({ command, stage: group.stage })))
    .map(({ command, stage }, index) => ({ stage, id: `verify-${index + 1}`, command, cwd: ".", timeoutMs: 120_000, required: true, expectedExitCodes: [0] }));
  return {
    ...profile,
    verificationPolicy: { ...profile.verificationPolicy, items, broaderPolicy, maxRepairAttempts: null },
    resiliencePolicy: { ...profile.resiliencePolicy, maxToolSelfCorrections: null },
  };
}

export function ProfileVerificationEditor({ profile, refresh }: { profile?: Profile; refresh: () => Promise<void> }) {
  const [commands, setCommands] = useState("");
  const [broaderCommands, setBroaderCommands] = useState("");
  const [broaderPolicy, setBroaderPolicy] = useState<"required" | "optional" | "disabled">("optional");
  useEffect(() => {
    setBroaderPolicy(profile?.verificationPolicy.broaderPolicy ?? "optional");
    setCommands(profile?.verificationPolicy.items.filter(item => (item.stage ?? "local") === "local").map(item => item.command).join("\n") ?? "");
    setBroaderCommands(profile?.verificationPolicy.items.filter(item => item.stage === "broader").map(item => item.command).join("\n") ?? "");
  }, [profile]);
  if (!profile) return null;
  return <BuiGlassPanel className="mt-6 p-4">
    <div className="flex items-center gap-3">
      <span className="text-[10px] font-semibold tracking-widest text-accent-text">VERIFICATION MATRIX</span>
      <strong className="text-sm text-text">分层验证 · 使用项目测试入口</strong>
    </div>
    <p className="mt-2 text-xs text-text-muted">将测试用例写入 test 文件，通过项目测试入口批量执行。每行可配置一个测试套件或类型检查入口。</p>
    <textarea className="mt-3 min-h-[90px] w-full resize-y rounded-xl border border-line bg-black/30 p-3 font-mono text-xs text-text outline-none placeholder:text-text-muted" value={commands} onChange={event => setCommands(event.target.value)} aria-label="局部验证命令" placeholder={"局部验证：相关测试文件\npnpm test path/to/feature.test.ts"} />
    <div className="mt-3 flex flex-wrap gap-4 text-xs text-text">
      <span>修复次数不限，受运行总预算约束</span>
      <label>扩大验证策略 <select aria-label="扩大验证策略" value={broaderPolicy} onChange={event => setBroaderPolicy(event.target.value as typeof broaderPolicy)}><option value="optional">可选（无配置时明确跳过）</option><option value="required">必需（无配置时不能完成）</option><option value="disabled">禁用（记录策略原因）</option></select></label>
    </div>
    <p className="mt-2 text-xs text-text-muted">分步修改任务完成局部验证和集成测试后，核对当前完整 diff 与逐项需求证据。测试失败后修复代码与测试，证据过期后重新验证，持续直到通过。独立模型评审已取消。</p>
    <textarea className="mt-3 min-h-[90px] w-full rounded-xl border border-line bg-black/30 p-3 font-mono text-xs text-text" aria-label="扩大验证命令" value={broaderCommands} onChange={event => setBroaderCommands(event.target.value)} placeholder={"扩大验证：项目测试套件，可留空\npnpm test"} />
    <div className="mt-2 flex justify-end"><BuiButton variant="primary" size="sm" onClick={async () => {
      await window.harness.request({ method: "profiles.upsert", params: profileWithVerificationInputs(profile, commands, broaderCommands, broaderPolicy) });
      await refresh();
    }}>保存验证矩阵</BuiButton></div>
  </BuiGlassPanel>;
}
