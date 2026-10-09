import React, { useEffect, useState } from "react";
import { GenerationPolicySchema, type GenerationPolicy, type Profile } from "@harness/protocol";
import { BuiButton } from "../ui/button.js";
import { BuiGlassPanel } from "../ui/card.js";

export function profileWithGenerationInputs(profile: Profile, main: string): Profile {
  const policy: GenerationPolicy = { ...profile.generationPolicy };
  delete policy.maxOutputTokens;
  const text = main.trim();
  if (text) {
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("主回答最大输出必须为正整数 token，或留空使用默认值");
    policy.maxOutputTokens = value;
  }
  const { generationPolicy: _previous, ...rest } = profile;
  return Object.keys(policy).length ? { ...rest, generationPolicy: GenerationPolicySchema.parse(policy) } : rest;
}

export function ProfileGenerationEditor({ profile, refresh }: { profile?: Profile; refresh: () => Promise<void> }) {
  const [main, setMain] = useState(() => String(profile?.generationPolicy?.maxOutputTokens ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setMain(String(profile?.generationPolicy?.maxOutputTokens ?? ""));
    setError("");
    setSaved(false);
  }, [profile]);
  if (!profile) return null;
  return (
    <BuiGlassPanel className="p-4">
      <h3 className="text-sm font-semibold text-text">最大输出 token · {profile.name}</h3>
      <p className="mt-2 text-xs text-text-muted">限制每次模型请求的输出，包含推理 token。保存后用于新运行；已有运行沿用启动时的配置。实际额度还受模型能力和剩余上下文限制。</p>
      <fieldset className="mt-3 flex flex-wrap gap-4 text-xs text-text" disabled={busy}>
        <legend className="sr-only">Profile 输出额度</legend>
        <label className="flex flex-col gap-2">
          单次主回答最大输出 token
          <input aria-label="单次主回答最大输出 token" type="number" min={1} step={1} value={main} placeholder="393216（默认）" className="rounded-xl border border-line bg-black/30 p-2 font-mono" onChange={event => { setMain(event.target.value); setSaved(false); }} />
        </label>
      </fieldset>
      <p className="mt-2 text-xs text-text-muted">留空时主回答默认 393,216。完成条件由真实测试、完整 diff 和逐项需求证据验收决定，不再发起独立模型评审。</p>
      {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
      {saved && <p className="mt-2 text-xs text-text-muted" role="status">输出额度已保存，用于新运行。</p>}
      <div className="mt-3 flex justify-end">
        <BuiButton variant="primary" size="sm" disabled={busy} onClick={async () => {
          setError("");
          setSaved(false);
          setBusy(true);
          try {
            const updated = profileWithGenerationInputs(profile, main);
            await window.harness.request({ method: "profiles.upsert", params: updated });
            await refresh();
            setSaved(true);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        }}>{busy ? "保存中…" : "保存输出额度"}</BuiButton>
      </div>
    </BuiGlassPanel>
  );
}
