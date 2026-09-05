import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import pg from "pg";

export interface StoredProvider {
  id: string;
  type: "openai" | "anthropic" | "gemini" | "openai-compatible";
  baseUrl: string;
  apiKey: string;
  models: Array<{ alias: string; modelId: string; vision: boolean; qualityScore: number; latencyScore: number; inputUsdPerMillion: number; outputUsdPerMillion: number }>;
}

export class GatewayStore {
  private readonly pool: pg.Pool;
  private readonly keys: Map<string, Buffer>;
  private readonly currentVersion: string;

  constructor(connectionString: string, masterKey: string, archiveKeys: Array<{ version: string; key: string }> = [], currentKey: string = masterKey, currentVersion = "v1") {
    this.pool = new pg.Pool({ connectionString, max: 10 });
    this.currentVersion = currentVersion;
    this.keys = new Map([[currentVersion, createHash("sha256").update(currentKey).digest()]]);
    for (const archived of archiveKeys) {
      this.keys.set(archived.version, createHash("sha256").update(archived.key).digest());
    }
  }

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS pairing_codes (code_hash TEXT PRIMARY KEY, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, attempts INTEGER NOT NULL DEFAULT 0);
      ALTER TABLE pairing_codes ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS devices (id UUID PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, max_daily_usd NUMERIC NOT NULL DEFAULT 20, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS provider_credentials (id TEXT PRIMARY KEY, type TEXT NOT NULL, base_url TEXT NOT NULL, encrypted_key TEXT NOT NULL, models JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS usage_audit (id BIGSERIAL PRIMARY KEY, device_id UUID NOT NULL REFERENCES devices(id), provider_id TEXT NOT NULL, model_id TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, estimated_usd NUMERIC NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS usage_device_day ON usage_audit(device_id, created_at);
    `);
  }

  async close(): Promise<void> { await this.pool.end(); }

  async createPairingCode(code: string, expiresAt: Date): Promise<void> {
    await this.pool.query("INSERT INTO pairing_codes(code_hash, expires_at) VALUES($1,$2)", [digest(code), expiresAt]);
  }

  async pair(code: string, name: string): Promise<{ id: string; token: string }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const paired = await client.query("UPDATE pairing_codes SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() AND attempts<5 RETURNING code_hash", [digest(code)]);
      if (paired.rowCount !== 1) {
        await client.query("UPDATE pairing_codes SET attempts=attempts+1 WHERE code_hash=$1 AND used_at IS NULL", [digest(code)]);
        throw new Error("Pairing code is invalid or expired");
      }
      const id = crypto.randomUUID();
      const token = randomBytes(32).toString("base64url");
      await client.query("INSERT INTO devices(id,name,token_hash) VALUES($1,$2,$3)", [id, name, digest(token)]);
      await client.query("COMMIT");
      return { id, token };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticate(token: string): Promise<{ id: string; name: string; maxDailyUsd: number } | undefined> {
    const result = await this.pool.query("SELECT id,name,max_daily_usd FROM devices WHERE token_hash=$1 AND revoked_at IS NULL", [digest(token)]);
    const row = result.rows[0];
    return row ? { id: String(row.id), name: String(row.name), maxDailyUsd: Number(row.max_daily_usd) } : undefined;
  }

  async revokeDevice(id: string): Promise<void> {
    await this.pool.query("UPDATE devices SET revoked_at=now() WHERE id=$1", [id]);
  }

  async putProvider(provider: StoredProvider): Promise<void> {
    await this.pool.query(
      "INSERT INTO provider_credentials(id,type,base_url,encrypted_key,models) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET type=excluded.type,base_url=excluded.base_url,encrypted_key=excluded.encrypted_key,models=excluded.models,updated_at=now()",
      [provider.id, provider.type, provider.baseUrl, this.encrypt(provider.apiKey), JSON.stringify(provider.models)]
    );
  }

  async listProviders(): Promise<StoredProvider[]> {
    const result = await this.pool.query("SELECT id,type,base_url,encrypted_key,models FROM provider_credentials ORDER BY id");
    return result.rows.map((row) => ({ id: String(row.id), type: row.type, baseUrl: String(row.base_url), apiKey: this.decrypt(String(row.encrypted_key)), models: row.models }));
  }

  async findModel(alias: string): Promise<{ provider: StoredProvider; model: StoredProvider["models"][number] } | undefined> {
    for (const provider of await this.listProviders()) {
      const model = provider.models.find((candidate) => candidate.alias === alias);
      if (model) return { provider, model };
    }
    return undefined;
  }

  async usedToday(deviceId: string): Promise<number> {
    const result = await this.pool.query("SELECT COALESCE(sum(estimated_usd),0) AS total FROM usage_audit WHERE device_id=$1 AND created_at >= date_trunc('day', now())", [deviceId]);
    return Number(result.rows[0]?.total ?? 0);
  }

  async audit(deviceId: string, providerId: string, modelId: string, inputTokens: number, outputTokens: number, estimatedUsd: number): Promise<void> {
    await this.pool.query("INSERT INTO usage_audit(device_id,provider_id,model_id,input_tokens,output_tokens,estimated_usd) VALUES($1,$2,$3,$4,$5,$6)", [deviceId, providerId, modelId, inputTokens, outputTokens, estimatedUsd]);
  }

  async listAudit(limit = 200): Promise<unknown[]> {
    return (await this.pool.query("SELECT device_id,provider_id,model_id,input_tokens,output_tokens,estimated_usd,created_at FROM usage_audit ORDER BY id DESC LIMIT $1", [limit])).rows;
  }

  private encrypt(value: string): string {
    return encryptWithKey(this.keys.get(this.currentVersion)!, value, this.currentVersion);
  }

  private decrypt(value: string): string {
    return decryptWithKey(this.keys, value);
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function encryptWithKey(key: Buffer, value: string, version: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [version, nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Decrypt with key-version selection. Accepts the legacy three-part format using the "v1" key. */
export function decryptWithKey(keys: Map<string, Buffer>, value: string): string {
  const parts = value.split(".");
  const version = parts.length === 4 ? parts[0]! : "v1";
  const key = keys.get(version);
  if (!key) throw new Error(`Unknown provider credential key version: ${version}`);
  const [nonce, tag, ciphertext] = parts.slice(parts.length - 3);
  if (!nonce || !tag || !ciphertext) throw new Error("Corrupted provider credential");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

