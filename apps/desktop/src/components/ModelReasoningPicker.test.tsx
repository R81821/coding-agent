import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ModelDescriptor, ReasoningEffort } from "@harness/protocol";
import { ModelReasoningPicker, ReasoningTriangle, modelDisplayName, reasoningOptions, reasoningUiOptions } from "./ModelReasoningPicker.js";

function model(overrides: Partial<ModelDescriptor> = {}, efforts?: ReasoningEffort[]): ModelDescriptor {
  return {
    providerId: "openai", modelId: "gpt-6.1-sol", displayName: "OpenAI", healthy: true,
    qualityScore: .9, latencyScore: .8, inputUsdPerMillion: 2, outputUsdPerMillion: 12,
    capabilities: { vision: true, tools: true, parallelTools: true, structuredOutput: true, maxContextTokens: 128000, dataPolicy: "cloud", ...(efforts ? { reasoningEfforts: efforts } : {}) },
    ...overrides,
  };
}
const configuredModel = model({}, ["low", "medium", "high", "xhigh", "max"]);

describe("composer reasoning picker", () => {
  it("shows the configured model and screenshot-style Ultra label without offering model choice", () => {
    const html = renderToStaticMarkup(<ModelReasoningPicker model={configuredModel} effort="xhigh" onChange={() => {}} />);
    expect(html).toContain('class="model-reasoning-current-model">gpt-6.1-sol</span>');
    expect(html).toContain('class="model-reasoning-current-effort">Ultra</span>');
    expect(html).toContain('aria-label="模型与推理等级：gpt-6.1-sol，Ultra"');
    expect(html).toContain('title="gpt-6.1-sol · Ultra"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("自动选模");
    expect(html).not.toContain('role="listbox"');
  });

  it("shows a neutral reasoning caption for an unset level while retaining the configured model", () => {
    const html = renderToStaticMarkup(<ModelReasoningPicker model={configuredModel} effort={null} onChange={() => {}} />);
    expect(html).toContain('class="model-reasoning-current-model">gpt-6.1-sol</span>');
    expect(html).toContain('class="model-reasoning-current-effort">推理</span>');
    expect(html).not.toContain("默认");
  });

  it("renders exactly four tiers and disables unsupported levels without inventing provider parameters", () => {
    const constrained = model({}, ["none", "medium", "low", "minimal", "medium"]);
    expect(reasoningOptions(constrained)).toEqual(["medium", "low", "minimal", "none"]);
    const html = renderToStaticMarkup(<ReasoningTriangle model={constrained} effort="low" onChange={() => {}} />);
    expect(html).toContain('class="model-reasoning-triangle"');
    expect(html.match(/role="radio"/g)).toHaveLength(4);
    expect(html.indexOf('aria-label="推理等级 Medium"')).toBeLessThan(html.indexOf('aria-label="推理等级 Low"'));
    expect(html).toContain('disabled="" aria-checked="false" aria-label="推理等级 High"');
    expect(html).toContain('disabled="" aria-checked="false" aria-label="推理等级 Ultra"');
    expect(html).not.toContain('aria-label="推理等级 关闭"');
    expect(html).not.toContain('aria-label="推理等级 Minimal"');
    expect(html).not.toContain('aria-label="使用模型默认推理等级"');
    expect(html).not.toContain('aria-label="推理等级 Max"');
    expect(html).not.toContain("<header");
    expect(html).not.toContain("<section");
    expect(html).not.toContain("模型列表");
    expect(html).not.toContain("model-reasoning-tip");
    expect(html).not.toContain("默认");
  });

  it("orders only Ultra, High, Medium and Low from the widest tier down without an empty bottom cell", () => {
    const html = renderToStaticMarkup(<ReasoningTriangle model={configuredModel} effort="xhigh" onChange={() => {}} />);
    const labels = ["Ultra", "High", "Medium", "Low"];
    const positions = labels.map(label => html.indexOf(`aria-label="推理等级 ${label}"`));
    expect(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!))).toBe(true);
    expect(html.match(/role="radio"/g)).toHaveLength(4);
    expect(html).not.toContain("model-reasoning-tip");
    expect(html).not.toContain('aria-label="推理等级 Max"');
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
  });

  it("disables all tiers for a model without reasoning capabilities", () => {
    const generic = model({ modelId: "custom-local-model", displayName: "Local coder" });
    const html = renderToStaticMarkup(<ReasoningTriangle model={generic} effort={null} onChange={() => {}} />);
    expect(reasoningOptions(generic)).toEqual([]);
    expect(html.match(/role="radio"/g)).toHaveLength(4);
    expect(html.match(/disabled=""/g)).toHaveLength(4);
    expect(html).not.toContain('aria-label="使用模型默认推理等级"');
  });

  it("maps Ultra to xhigh first, or max for providers that support max", () => {
    expect(reasoningUiOptions(configuredModel)[0]).toEqual({ label: "Ultra", value: "xhigh", supported: true });
    const maxProvider = model({ providerId: "anthropic", modelId: "claude-opus" }, ["low", "medium", "high", "max"]);
    expect(reasoningUiOptions(maxProvider)[0]).toEqual({ label: "Ultra", value: "max", supported: true });
    const html = renderToStaticMarkup(<ModelReasoningPicker model={configuredModel} effort="max" onChange={() => {}} />);
    expect(html).toContain('class="model-reasoning-current-effort">Ultra</span>');
    const triangle = renderToStaticMarkup(<ReasoningTriangle model={configuredModel} effort="max" onChange={() => {}} />);
    expect(triangle).toContain('aria-checked="true" aria-label="推理等级 Ultra"');
  });

  it("keeps unavailable models from exposing usable reasoning controls", () => {
    const unavailable = { ...configuredModel, healthy: false };
    expect(reasoningUiOptions(unavailable).every(option => !option.supported)).toBe(true);
  });

  it("disables changes while a run is active and explains the reason", () => {
    const html = renderToStaticMarkup(<ModelReasoningPicker model={configuredModel} effort="high" onChange={() => {}} disabled disabledReason="暂停的任务将继续使用原推理等级" />);
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="暂停的任务将继续使用原推理等级"');
  });

  it("shows loading and model availability without adding model selection panels", () => {
    const loading = renderToStaticMarkup(<ModelReasoningPicker model={undefined} effort={null} onChange={() => {}} loading />);
    expect(loading).toContain("读取模型…");
    expect(loading).toContain('disabled=""');
    const missing = renderToStaticMarkup(<ModelReasoningPicker model={undefined} effort={null} onChange={() => {}} error="读取模型失败" />);
    expect(missing).toContain("模型未配置");
    expect(missing).toContain('title="读取模型失败"');
    expect(missing).not.toContain('role="listbox"');
  });

  it("preserves configured model ids verbatim instead of display aliases or formatted names", () => {
    expect(modelDisplayName(model({ displayName: "My coder", modelId: "gpt-6.1-sol" }))).toBe("gpt-6.1-sol");
    expect(modelDisplayName(model({ displayName: "Anthropic Claude", modelId: "claude-sonnet-4-6" }))).toBe("claude-sonnet-4-6");
    expect(modelDisplayName(model({ displayName: "Google Gemini", modelId: "gemini-2.5-pro" }))).toBe("gemini-2.5-pro");
    expect(modelDisplayName(model({ displayName: "Friendly custom alias", modelId: "custom-model" }))).toBe("custom-model");
    const html = renderToStaticMarkup(<ModelReasoningPicker model={model({ displayName: "Friendly custom alias", modelId: "custom-model" })} effort="low" onChange={() => {}} />);
    expect(html).toContain('class="model-reasoning-current-model">custom-model</span>');
    expect(html).toContain('aria-label="模型与推理等级：custom-model，Low"');
    expect(html).toContain('title="custom-model · Low"');
    expect(html).not.toContain("Friendly custom alias");
  });
});
