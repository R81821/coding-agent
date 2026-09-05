import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { argon2id } from "hash-wasm";

interface KeyEnvelope {
  version: 1;
  salt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export class VaultCrypto {
  private constructor(private readonly masterKey: Buffer) {}

  private static async openFromMirror(envelopePath: string, wrapKey: Buffer): Promise<VaultCrypto | undefined> {
    const mirror = await parseMirrorEnvelope(envelopePath);
    if (!mirror) return undefined;
    try {
      const masterKey = decryptRaw(wrapKey, {
        nonce: Buffer.from(mirror.nonce, "base64"),
        tag: Buffer.from(mirror.tag, "base64"),
        ciphertext: Buffer.from(mirror.ciphertext, "base64"),
      });
      await writeEnvelopeAtomic(envelopePath, mirror);
      return new VaultCrypto(masterKey);
    } catch {
      return undefined;
    }
  }

  static async open(envelopePath: string, passphrase: string): Promise<VaultCrypto> {
    let envelope: KeyEnvelope | undefined;
    try {
      envelope = JSON.parse(await readFile(envelopePath, "utf8")) as KeyEnvelope;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const mirror = await parseMirrorEnvelope(envelopePath);
        if (!mirror) throw error;
        await writeEnvelopeAtomic(envelopePath, mirror);
        envelope = mirror;
      }
    }
    if (!envelope) {
      await mkdir(dirname(envelopePath), { recursive: true });
      const salt = randomBytes(16);
      const wrapKey = await deriveKey(passphrase, salt);
      const masterKey = randomBytes(32);
      const encrypted = encryptRaw(wrapKey, masterKey);
      envelope = {
        version: 1,
        salt: salt.toString("base64"),
        nonce: encrypted.nonce.toString("base64"),
        tag: encrypted.tag.toString("base64"),
        ciphertext: encrypted.ciphertext.toString("base64")
      };
      await writeEnvelopeAtomic(envelopePath, envelope);
      await mirrorEnvelopeBackup(envelopePath);
      wrapKey.fill(0);
      return new VaultCrypto(masterKey);
    }
    if (envelope.version !== 1) throw new Error(`Unsupported vault envelope version: ${String(envelope.version)}`);
    const wrapKey = await deriveKey(passphrase, Buffer.from(envelope.salt, "base64"));
    try {
      const masterKey = decryptRaw(wrapKey, {
        nonce: Buffer.from(envelope.nonce, "base64"),
        tag: Buffer.from(envelope.tag, "base64"),
        ciphertext: Buffer.from(envelope.ciphertext, "base64")
      });
      await mirrorEnvelopeBackup(envelopePath);
      return new VaultCrypto(masterKey);
    } catch (error) {
      // A valid parse but failed decrypt means a wrong passphrase or a corrupted
      // envelope. Fall back to the mirror only when the mirror decrypts; otherwise
      // keep the passphrase error (the mirror is wrapped with the same passphrase).
      const restored = await VaultCrypto.openFromMirror(envelopePath, wrapKey);
      if (restored) return restored;
      throw error instanceof Error && error.message.startsWith("Invalid application")
        ? error
        : new Error("Invalid application passphrase or corrupted key envelope");
    } finally {
      wrapKey.fill(0);
    }
  }

  encryptJson(value: unknown, aad = "harness-json-v1"): string {
    const encrypted = encryptRaw(this.masterKey, Buffer.from(JSON.stringify(value), "utf8"), aad);
    return ["v1", encrypted.nonce.toString("base64url"), encrypted.tag.toString("base64url"), encrypted.ciphertext.toString("base64url")].join(".");
  }

  decryptJson<T>(value: string, aad = "harness-json-v1"): T {
    const [version, nonce, tag, ciphertext] = value.split(".");
    if (version !== "v1" || !nonce || !tag || !ciphertext) throw new Error("Malformed encrypted value");
    const clear = decryptRaw(
      this.masterKey,
      { nonce: Buffer.from(nonce, "base64url"), tag: Buffer.from(tag, "base64url"), ciphertext: Buffer.from(ciphertext, "base64url") },
      aad
    );
    return JSON.parse(clear.toString("utf8")) as T;
  }

  encryptBuffer(value: Buffer, aad: string): Buffer {
    const encrypted = encryptRaw(this.masterKey, value, aad);
    return Buffer.concat([Buffer.from("HAB1"), encrypted.nonce, encrypted.tag, encrypted.ciphertext]);
  }

  decryptBuffer(value: Buffer, aad: string): Buffer {
    if (value.subarray(0, 4).toString("ascii") !== "HAB1") throw new Error("Invalid encrypted blob header");
    return decryptRaw(this.masterKey, { nonce: value.subarray(4, 16), tag: value.subarray(16, 32), ciphertext: value.subarray(32) }, aad);
  }

  searchToken(value: string): string {
    return createHmac("sha256", this.masterKey).update(`search:${value.toLocaleLowerCase()}`).digest("hex");
  }

  dispose(): void {
    this.masterKey.fill(0);
  }
}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  if (passphrase.length < 10) throw new Error("Application passphrase must contain at least 10 characters");
  const key = await argon2id({ password: passphrase, salt, memorySize: 65_536, iterations: 3, parallelism: 1, hashLength: 32, outputType: "binary" });
  return Buffer.from(key);
}

function encryptRaw(key: Buffer, value: Buffer, aad?: string): { nonce: Buffer; tag: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return { nonce, tag: cipher.getAuthTag(), ciphertext };
}

function decryptRaw(key: Buffer, value: { nonce: Buffer; tag: Buffer; ciphertext: Buffer }, aad?: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, value.nonce);
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(value.tag);
  return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]);
}

async function writeEnvelopeAtomic(envelopePath: string, envelope: KeyEnvelope): Promise<void> {
  const temporary = `${envelopePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(envelope, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, envelopePath);
}

async function mirrorEnvelopeBackup(envelopePath: string): Promise<void> {
  const backupPath = `${envelopePath}.bak`;
  const temporary = `${backupPath}.${process.pid}.tmp`;
  await copyFile(envelopePath, temporary);
  await rename(temporary, backupPath);
}

async function parseMirrorEnvelope(envelopePath: string): Promise<KeyEnvelope | undefined> {
  try {
    return JSON.parse(await readFile(`${envelopePath}.bak`, "utf8")) as KeyEnvelope;
  } catch {
    return undefined;
  }
}

