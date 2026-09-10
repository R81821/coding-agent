import { applyPatchTool, browserTool, gitDiffTool, listFilesTool, readFileTool, readRangeTool, searchTextTool, terminalTool } from "./builtins.js";
import { ToolRegistry } from "./types.js";

export * from "./types.js";
export * from "./paths.js";
export * from "./process.js";
export * from "./builtins.js";
export * from "./browser-cdp.js";
export * from "./search.js";
export * from "./grants.js";

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(readRangeTool)
    .register(listFilesTool)
    .register(searchTextTool)
    .register(applyPatchTool)
    .register(terminalTool)
    .register(gitDiffTool)
    .register(browserTool);
}
