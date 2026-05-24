import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { isCommandBlocked } from './command-guard';
import { formatExecToolError } from './errors';

const execAsync = promisify(exec);

/**
 * Execute a shell command on behalf of the AI agent.
 * Applies a minimal destructive-command blocklist before running.
 */
export async function executeRunCommand(command: string, cwd: string): Promise<string> {
  const trimmed = command?.trim();
  if (!trimmed) return 'Error: command is required';

  if (isCommandBlocked(trimmed)) {
    return `Error: command blocked for safety (${trimmed.slice(0, 80)}…)`;
  }

  try {
    const { stdout, stderr } = await execAsync(trimmed, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return `STDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
  } catch (error: unknown) {
    return formatExecToolError(error);
  }
}
