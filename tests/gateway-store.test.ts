import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { decryptWithKey, encryptWithKey } from "../apps/gateway/src/store.js";

function keyOf(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

describe("gateway credential encryption with key rotation", () => {
  it("round-trips with the current key", () => {
    const key = keyOf("master-v2");
    const encrypted = encryptWithKey(key, "sk-secret", "v2");
    expect(decryptWithKey(new Map([["v2", key]]), encrypted)).toBe("sk-secret");
  });

  it("decrypts with an archived key after rotation", () => {
    const oldKey = keyOf("master-v1");
    const newKey = keyOf("master-v2");
    const encrypted = encryptWithKey(oldKey, "sk-secret", "v1");
    expect(decryptWithKey(new Map([["v2", newKey], ["v1", oldKey]]), encrypted)).toBe("sk-secret");
  });

  it("rejects ciphertext when no matching key version exists", () => {
    const oldKey = keyOf("master-v1");
    const newKey = keyOf("master-v2");
    const encrypted = encryptWithKey(oldKey, "sk-secret", "v1");
    expect(() => decryptWithKey(new Map([["v2", newKey]]), encrypted)).toThrow("key version");
  });

  it("still decrypts the legacy three-part format with the v1 key", () => {
    const key = keyOf("master-v1");
    const legacy = encryptWithKey(key, "sk-secret", "v1").split(".").slice(1).join(".");
    expect(decryptWithKey(new Map([["v1", key]]), legacy)).toBe("sk-secret");
  });

  it("fails decryption with the wrong key", () => {
    const encrypted = encryptWithKey(keyOf("master-v1"), "sk-secret", "v1");
    expect(() => decryptWithKey(new Map([["v1", keyOf("other")]]), encrypted)).toThrow();
  });
});
