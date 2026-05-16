export function endsWithSentenceTerminator(text: string): boolean {
  const tail = text.replace(/\s+$/, '').slice(-8);
  return /[。！？.!?](["'’”」』）)\]]*|```\s*)$/.test(tail) || tail.endsWith('```');
}

export function looksLikeIncompleteModelText(text: string): boolean {
  const normalized = text.replace(/\s+$/, '');
  if (normalized.length <= 20) return false;
  if (endsWithSentenceTerminator(normalized)) return false;
  return /[\p{Script=Han}A-Za-z0-9]$/u.test(normalized);
}

export function shouldContinueModelText(options: {
  finishReason: string | null | undefined;
  modelText: string;
  lastStepWasText: boolean;
  lastMessageHasToolCall: boolean;
}): boolean {
  if (!options.lastStepWasText || options.lastMessageHasToolCall) return false;
  if (!looksLikeIncompleteModelText(options.modelText)) return false;
  return options.finishReason !== 'length';
}
