import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

const nonPublic = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) nonPublic.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["::1", 128], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) nonPublic.addSubnet(network, prefix, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  // BlockList also recognizes IPv4-mapped IPv6 spellings of the IPv4 ranges.
  return family === 0 || nonPublic.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** The HTTP connection consumes these exact validated DNS answers, with no second lookup. */
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  void lookup(hostname, { ...options, all: true }).then(records => {
    if (!records.length || records.some(record => isPrivateAddress(record.address))) {
      callback(new Error("Plugin broker denied non-public address"), []);
    } else if (options.all) callback(null, records);
    else callback(null, records[0]!.address, records[0]!.family);
  }, error => callback(error as NodeJS.ErrnoException, []));
};

/** Bounded GET with validated DNS, no redirect following and no shared socket pool. */
export function fetchPluginUrl(url: URL, signal: AbortSignal): Promise<{ status: number; body: string }> {
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    return Promise.reject(new Error("Plugin broker only allows http(s) URLs without credentials"));
  }
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", agent: false, lookup: publicLookup,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    }, response => {
      const status = response.statusCode ?? 502;
      response.on("error", reject);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.destroy();
        reject(new Error("Plugin broker denied HTTP redirect"));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        const bounded = chunk.subarray(0, 1_000_000 - bytes);
        chunks.push(bounded);
        bytes += bounded.length;
        if (bytes >= 1_000_000) {
          resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
          response.destroy();
        }
      });
      response.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}
