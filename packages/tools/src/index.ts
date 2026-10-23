import { applyPatchTool, browserTool, gitDiffTool, listFilesTool, readFileTool, readRangeTool, searchTextTool, terminalTool } from "./builtins.js";
import { ToolRegistry } from "./types.js";
import { writeFileTool } from "./write-file.js";

export * from "./types.js";
export * from "./paths.js";
export * from "./process.js";
export * from "./builtins.js";
export * from "./browser-cdp.js";
export * from "./browser-screenshot.js";
export * from "./search.js";
export * from "./grants.js";
export * from "./write-file.js";

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readFileTool)
    .register(readRangeTool)
    .register(listFilesTool)
    .register(searchTextTool)
    .register(applyPatchTool)
    .register(writeFileTool)
    .register(terminalTool)
    .register(gitDiffTool)
    .register(browserTool);
}
export * from "./lightweight.js";
