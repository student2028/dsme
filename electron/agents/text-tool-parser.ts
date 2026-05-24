import { safeJsonParse } from '../lib/safe-json-parse.ts';
import type { JsonObject } from '../types/common';
import type { ParsedTextToolCall } from '../types/agent-messages';

const RUNNABLE: Record<string, string> = {
  python: 'python3',
  py: 'python3',
  javascript: 'node',
  js: 'node',
  typescript: 'npx tsx',
  ts: 'npx tsx',
  bash: 'bash',
  sh: 'bash',
  zsh: 'zsh',
};

const PARAM_KEY_TO_TOOL: Record<string, string> = {
  command: 'run_command',
  filepath: 'read_file',
  query: 'web_search',
  url: 'fetch_url',
  dirpath: 'list_directory',
  ref: 'browser_click',
};

function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toolNameFromObject(data: JsonObject, availableTools: string[]): string | null {
  const name = data.name;
  if (typeof name === 'string' && availableTools.includes(name)) return name;
  for (const [key, toolName] of Object.entries(PARAM_KEY_TO_TOOL)) {
    if (key in data && availableTools.includes(toolName)) return toolName;
  }
  return null;
}

function argsFromObject(data: JsonObject): JsonObject {
  if (data.name && typeof data.name === 'string') {
    const args = data.parameters ?? data.arguments;
    return isJsonObject(args) ? args : {};
  }
  return data;
}

/**
 * Parse tool calls embedded in plain model text (Hermes / XML / JSON / code blocks).
 * Shared by Vercel and Builtin agent kernels.
 */
export function parseTextToolCalls(text: string, availableTools: string[]): ParsedTextToolCall[] {
  const hermesMatch = text.match(/\[TOOL_CALLS\]\s*(\[[\s\S]*?\])/);
  if (hermesMatch) {
    const calls = safeJsonParse(hermesMatch[1]);
    if (Array.isArray(calls)) {
      return calls
        .filter((c): c is JsonObject => isJsonObject(c) && typeof c.name === 'string' && availableTools.includes(c.name))
        .map(c => ({
          name: c.name as string,
          args: (isJsonObject(c.arguments) ? c.arguments : isJsonObject(c.parameters) ? c.parameters : {}) as JsonObject,
        }));
    }
  }

  const xmlRegex = /<function=([^>]+)>([\s\S]*?)<\/function>/g;
  const xmlCalls: ParsedTextToolCall[] = [];
  let xmlMatch: RegExpExecArray | null;
  while ((xmlMatch = xmlRegex.exec(text)) !== null) {
    const name = xmlMatch[1].trim();
    if (!availableTools.includes(name)) continue;
    const parsed = safeJsonParse(xmlMatch[2].trim());
    xmlCalls.push({ name, args: isJsonObject(parsed) ? parsed : {} });
  }
  if (xmlCalls.length > 0) return xmlCalls;

  const jsonBlockRegex = /```(?:json)?\s*\n?\s*(\{[\s\S]*?\})\s*\n?```/g;
  const jsonCalls: ParsedTextToolCall[] = [];
  let jsonMatch: RegExpExecArray | null;
  while ((jsonMatch = jsonBlockRegex.exec(text)) !== null) {
    const data = safeJsonParse(jsonMatch[1]);
    if (!isJsonObject(data)) continue;
    const toolName = toolNameFromObject(data, availableTools);
    if (toolName) jsonCalls.push({ name: toolName, args: argsFromObject(data) });
  }
  if (jsonCalls.length > 0) return jsonCalls;

  const bareRegex = /\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"(?:parameters|arguments)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
  const bareCalls: ParsedTextToolCall[] = [];
  let bareMatch: RegExpExecArray | null;
  while ((bareMatch = bareRegex.exec(text)) !== null) {
    const name = bareMatch[1];
    if (!availableTools.includes(name)) continue;
    const parsed = safeJsonParse(bareMatch[2]);
    if (isJsonObject(parsed)) bareCalls.push({ name, args: parsed });
  }
  if (bareCalls.length > 0) return bareCalls;

  const codeBlockRegex = /```(\w+)\n([\s\S]*?)```/g;
  const codeCalls: ParsedTextToolCall[] = [];
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = codeBlockRegex.exec(text)) !== null) {
    const lang = codeMatch[1].toLowerCase();
    const code = codeMatch[2].trim();
    const runner = RUNNABLE[lang];
    if (!runner || code.length < 10) continue;
    const ext =
      lang === 'python' || lang === 'py' ? '.py'
        : lang === 'javascript' || lang === 'js' ? '.js'
          : lang === 'typescript' || lang === 'ts' ? '.ts'
            : '.sh';
    const filename = `scratch/auto_${Date.now()}${ext}`;
    codeCalls.push({ name: 'write_file', args: { filepath: filename, content: code } });
    codeCalls.push({ name: 'run_command', args: { command: `${runner} ${filename}` } });
  }
  if (codeCalls.length > 0) return codeCalls;

  return [];
}
