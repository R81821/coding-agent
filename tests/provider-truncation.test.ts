import { expect, it } from "vitest";
import { AnthropicProvider, GeminiProvider, OpenAICompatibleProvider, OpenAIProvider, descriptor } from "@harness/providers";
import type { ProviderStreamEvent } from "@harness/providers";
import type { ModelRequest } from "@harness/protocol";
const model = descriptor({ providerId: "fixture", modelId: "fixture", displayName: "fixture" });
const request: ModelRequest = {runId:"run", model, messages:[], tools:[], maxOutputTokens:10, parallelToolCalls:false, store:false};
const cases = [
 [OpenAICompatibleProvider, [{choices:[{delta:{content:"partial"},finish_reason:"length"}]}, {usage:{prompt_tokens:10,completion_tokens:10}, choices:[]}]],
 [AnthropicProvider, [{type:"content_block_delta",delta:{type:"text_delta",text:"partial"}}, {type:"message_delta",delta:{stop_reason:"max_tokens"},usage:{output_tokens:10}}]],
 [GeminiProvider, [{candidates:[{content:{parts:[{text:"partial"}]},finishReason:"MAX_TOKENS"}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:10}}]],
 [OpenAIProvider, [{type:"response.output_text.delta",delta:"partial"}, {type:"response.incomplete",response:{incomplete_details:{reason:"max_output_tokens"},usage:{input_tokens:10,output_tokens:10}}}]],
] as const;
it.each(cases)("reports explicit truncation and retains measured usage %#", async (Provider, frames) => {
 const provider = new Provider({id:"fixture",apiKey:"fixture",baseUrl:"https://fixture.test",models:[model],resolveAttachment:async()=>{throw Error("unused");},fetchImpl:async()=>new Response(frames.map(frame=>"data: "+JSON.stringify(frame)+"\n\n").join(""))});
 const events: ProviderStreamEvent[] = [];
 const drain = async () => {for await (const event of provider.stream(request,new AbortController().signal)) events.push(event);};
 await expect(drain()).rejects.toThrow(/截断/);
 expect(events.some(event=>event.type==="text_delta")).toBe(true);
 expect(events.find(event=>event.type==="usage")?.usage?.outputTokens).toBe(10);
});
