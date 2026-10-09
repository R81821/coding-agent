import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE } from "@harness/protocol";
import { ProfileVerificationEditor, profileWithVerificationInputs } from "./ProfileVerificationEditor.js";

describe("Profile verification settings", () => {
  it("guides users to file-based test suites and has no independent-review selector", () => {
    const html = renderToStaticMarkup(<ProfileVerificationEditor profile={DEFAULT_PROFILE} refresh={async () => {}} />);
    for (const text of ["test 文件", "批量执行", "局部验证命令", "扩大验证策略", "集成测试", "逐项需求证据", "独立模型评审已取消"]) expect(html).toContain(text);
    expect(html).not.toContain('aria-label="独立只读评审"');
    expect(renderToStaticMarkup(<ProfileVerificationEditor refresh={async () => {}} />)).toBe("");
  });

  it("saves suite entries while retaining historical review policy and output settings", () => {
    const profile = { ...DEFAULT_PROFILE, generationPolicy: { maxOutputTokens: 4096, reviewMaxOutputTokens: 8192 }, verificationPolicy: { ...DEFAULT_PROFILE.verificationPolicy, reviewPolicy: "risk_based" as const } };
    const updated = profileWithVerificationInputs(profile, "  pnpm test feature.test.ts \r\n\r\npnpm typecheck ", "pnpm test", "required");
    expect(updated.verificationPolicy.items.map(item => ({ command: item.command, stage: item.stage }))).toEqual([
      { command: "pnpm test feature.test.ts", stage: "local" }, { command: "pnpm typecheck", stage: "local" }, { command: "pnpm test", stage: "broader" },
    ]);
    expect(updated.verificationPolicy).toMatchObject({ broaderPolicy: "required", reviewPolicy: "risk_based", maxRepairAttempts: null });
    expect(updated.generationPolicy).toEqual(profile.generationPolicy);
    expect(updated.resiliencePolicy.maxToolSelfCorrections).toBeNull();
    expect(profile.verificationPolicy.items).toEqual(DEFAULT_PROFILE.verificationPolicy.items);
  });

  it("does not add review configuration when the Profile did not contain any", () => {
    const { reviewPolicy: _historical, ...verificationPolicy } = DEFAULT_PROFILE.verificationPolicy;
    const updated = profileWithVerificationInputs({ ...DEFAULT_PROFILE, verificationPolicy }, "pnpm test", "", "optional");
    expect(updated.verificationPolicy).not.toHaveProperty("reviewPolicy");
  });
});
