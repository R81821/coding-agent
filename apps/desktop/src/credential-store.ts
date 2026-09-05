import { spawn } from "node:child_process";

export const credentialNames = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "PARALLEL_API_KEY",
  "HARNESS_GATEWAY_TOKEN"
] as const;

export type CredentialName = typeof credentialNames[number];

const credentialScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
$vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
$resource = 'HarnessAgent'
if ($request.op -eq 'get') {
  try {
    $credential = $vault.Retrieve($resource, [string]$request.name)
    $credential.RetrievePassword()
    $result = @{ found = $true; value = $credential.Password }
  } catch {
    $result = @{ found = $false }
  }
} elseif ($request.op -eq 'set') {
  try {
    $existing = $vault.Retrieve($resource, [string]$request.name)
    $vault.Remove($existing)
  } catch {}
  $credential = [Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new($resource, [string]$request.name, [string]$request.value)
  $vault.Add($credential)
  $result = @{ ok = $true }
} elseif ($request.op -eq 'delete') {
  try {
    $existing = $vault.Retrieve($resource, [string]$request.name)
    $vault.Remove($existing)
  } catch {}
  $result = @{ ok = $true }
} else {
  throw 'Unknown credential operation'
}
[Console]::Out.Write(($result | ConvertTo-Json -Compress))
`;

export class WindowsCredentialStore {
  async environment(): Promise<Partial<Record<CredentialName, string>>> {
    const values: Partial<Record<CredentialName, string>> = {};
    for (const name of credentialNames) {
      const value = await this.get(name);
      if (value) values[name] = value;
    }
    return values;
  }

  async status(): Promise<Record<CredentialName, boolean>> {
    const values = {} as Record<CredentialName, boolean>;
    for (const name of credentialNames) values[name] = Boolean(await this.get(name));
    return values;
  }

  async set(name: CredentialName, value: string): Promise<void> {
    if (!value.trim()) throw new Error("Credential cannot be empty");
    await invokePowerShell({ op: "set", name, value });
  }

  async delete(name: CredentialName): Promise<void> {
    await invokePowerShell({ op: "delete", name });
  }

  private async get(name: CredentialName): Promise<string | undefined> {
    const result = await invokePowerShell<{ found: boolean; value?: string }>({ op: "get", name });
    return result.found ? result.value : undefined;
  }
}

async function invokePowerShell<T = { ok: boolean }>(request: Record<string, string>): Promise<T> {
  if (process.platform !== "win32") throw new Error("Windows Credential Locker is only available on Windows");
  const encoded = Buffer.from(credentialScript, "utf16le").toString("base64");
  return new Promise<T>((resolveRequest, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < 32_768) stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { if (stderr.length < 8_192) stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) reject(new Error(`Windows Credential Locker failed (${code}): ${stderr.trim()}`));
      else {
        try { resolveRequest(JSON.parse(stdout) as T); }
        catch { reject(new Error("Windows Credential Locker returned invalid output")); }
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
