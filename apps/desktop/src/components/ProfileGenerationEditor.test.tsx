import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "@harness/protocol";
import { ProfileGenerationEditor, profileWithGenerationInputs } from "./ProfileGenerationEditor.js";

describe("Profile generation settings", () => {
  it("keeps the main request limit editable without offering an inactive review limit", () => {
    const html = renderToStaticMarkup(<ProfileGenerationEditor profile={DEFAULT_PROFILE} refresh={async () => {}} />);
    expect(html).toContain('aria-label="单次主回答最大输出 token"');
    expect(html).not.toContain('aria-label="单次审核最大输出 token"');
    expect(html).toContain('min="1"');
    expect(html).toContain('step="1"');
    for (const text of ["393,216", "包含推理", "用于新运行", "真实测试", "逐项需求证据验收", "保存输出额度"]) expect(html).toContain(text);
  });

  it("renders persisted values on reopening the Profile editor", () => {
    const profile = profileWithGenerationInputs(DEFAULT_PROFILE, "12288");
    const html = renderToStaticMarkup(<ProfileGenerationEditor profile={profile} refresh={async () => {}} />);
    expect(html).toContain('value="12288"');
    expect(renderToStaticMarkup(<ProfileGenerationEditor refresh={async () => {}} />)).toBe("");
  });

  it("preserves historical review configuration while changing or clearing the main limit", () => {
    const profile = { ...DEFAULT_PROFILE, generationPolicy: { reviewMaxOutputTokens: 8192 }, verificationPolicy: { ...DEFAULT_PROFILE.verificationPolicy, reviewPolicy: "risk_based" as const } };
    const updated = profileWithGenerationInputs(profile, " 4096 ");
    expect(updated.generationPolicy).toEqual({ maxOutputTokens: 4096, reviewMaxOutputTokens: 8192 });
    expect(updated.verificationPolicy).toEqual(profile.verificationPolicy);
    expect(profileWithGenerationInputs(updated, "  ").generationPolicy).toEqual({ reviewMaxOutputTokens: 8192 });
    expect(profileWithGenerationInputs(DEFAULT_PROFILE, "")).not.toHaveProperty("generationPolicy");
    expect(profile.generationPolicy).toEqual({ reviewMaxOutputTokens: 8192 });
  });

  it("rejects invalid inputs before creating a save request", () => {
    for (const invalid of ["0", "-1", "1.5", "NaN", "128k", "Infinity", "9007199254740992"]) {
      expect(() => profileWithGenerationInputs(DEFAULT_PROFILE, invalid)).toThrow(/主回答最大输出必须为正整数/);
    }
  });
});
