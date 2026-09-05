export function daemonStartupError(stderr: string, exitCode: number | null): Error {
  if (/Invalid application passphrase or corrupted key envelope/i.test(stderr)) {
    return new Error("应用口令错误，或本地密钥文件已损坏。请使用创建此加密库时的口令。");
  }
  const explicit = [...stderr.matchAll(/^Error:\s*(.+)$/gim)].at(-1)?.[1]?.trim();
  if (explicit) return new Error(`daemon 启动失败：${explicit}`);
  return new Error(`daemon 启动失败${exitCode === null ? "" : `（退出码 ${exitCode}）`}。请查看桌面生命周期日志。`);
}

export function appendBounded(current: string, chunk: string, maxLength = 16_384): string {
  const combined = current + chunk;
  return combined.length <= maxLength ? combined : combined.slice(-maxLength);
}
