import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(appRoot, "dist"), { recursive: true });
await copyFile(resolve(appRoot, "..", "..", "packages", "persistence", "node_modules", "sql.js", "dist", "sql-wasm.wasm"), resolve(appRoot, "dist", "sql-wasm.wasm"));

