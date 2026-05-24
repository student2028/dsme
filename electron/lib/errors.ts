/** Normalize unknown thrown values for logging and user-facing tool output. */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string;
}

export function isExecError(error: unknown): error is ExecError {
  return error instanceof Error && ('stdout' in error || 'stderr' in error || 'code' in error);
}

export function formatExecToolError(error: unknown): string {
  if (isExecError(error)) {
    return `ERROR: ${error.message}\nSTDOUT:\n${error.stdout ?? ''}\nSTDERR:\n${error.stderr ?? ''}`;
  }
  return `ERROR: ${getErrorMessage(error)}`;
}
