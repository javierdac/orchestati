import { ToolRegistry } from './registry.js';
import { FS_TOOLS } from './builtin/fs.js';
import { runCommandTool } from './builtin/shell.js';
import { calculatorTool, httpFetchTool } from './builtin/misc.js';

export * from './types.js';
export * from './registry.js';
export * from './confirm.js';
export * from './sandbox.js';
export * from './builtin/fs.js';
export * from './builtin/shell.js';
export * from './builtin/misc.js';

/** Catalogo por defecto. */
export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry().register(
    ...FS_TOOLS,
    runCommandTool,
    calculatorTool,
    httpFetchTool,
  );
}
