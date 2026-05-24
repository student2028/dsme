/** Minimal blocklist for obviously destructive shell commands invoked by the AI agent. */
export const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf $HOME',
  'mkfs',
  ':(){',
  'dd if=',
  '> /dev/sd',
  'chmod -R 777 /',
  'format c:',
] as const;

export function isCommandBlocked(cmd: string): boolean {
  const normalized = cmd.trim().toLowerCase();
  return BLOCKED_COMMANDS.some(blocked => normalized.includes(blocked.toLowerCase()));
}
