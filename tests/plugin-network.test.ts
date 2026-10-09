import { beforeEach, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import type { LookupAddress, LookupAllOptions } from "node:dns";
import { publicLookup } from "../packages/extensions/src/plugin-network.js";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
beforeEach(() => vi.resetAllMocks());
const lookupAll = vi.mocked(lookup as (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>);

it("passes exactly the checked DNS records to the socket without a second resolution", async () => {
  const records = [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700::1111", family: 6 }];
  lookupAll.mockResolvedValue(records);
  const result = await new Promise((resolve, reject) => publicLookup("example.test", { all: true }, (error, answers) => error ? reject(error) : resolve(answers)));
  expect(result).toEqual(records);
  expect(lookup).toHaveBeenCalledTimes(1);
});

it("rejects a mixed public/private answer set before connecting", async () => {
  lookupAll.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "::ffff:7f00:1", family: 6 }]);
  await expect(new Promise((resolve, reject) => publicLookup("example.test", {}, (error, answer) => error ? reject(error) : resolve(answer)))).rejects.toThrow("non-public");
});

it("fails closed on DNS failure", async () => {
  lookupAll.mockRejectedValue(new Error("DNS unavailable"));
  await expect(new Promise((resolve, reject) => publicLookup("example.test", {}, (error, answer) => error ? reject(error) : resolve(answer)))).rejects.toThrow("DNS unavailable");
});
