export function countSearchResultLines(result: string): number {
  return result
    .split('\n')
    .map(line => line.trim())
    .filter(line =>
      line &&
      !line.startsWith('Results from ') &&
      line !== '---' &&
      !line.startsWith('WEB_SEARCH_') &&
      !line.startsWith('QUERY:') &&
      !line.startsWith('RESULT_COUNT:') &&
      !line.startsWith('INTERPRETATION_HINT:') &&
      !/^No results found for /i.test(line) &&
      !/^Search timeout for /i.test(line) &&
      !/^Error:/i.test(line)
    )
    .length;
}

export function hasUsableSearchResults(result: string): boolean {
  const text = String(result || '').trim();
  if (!text) return false;
  if (/^(Search timeout|No results found|Error:)/i.test(text)) return false;
  return countSearchResultLines(text) > 0;
}

export function formatWebSearchResult(query: string, result: string): string {
  const usable = hasUsableSearchResults(result);
  const count = countSearchResultLines(result);
  const status = usable ? 'ok' : 'empty';
  const hint = usable
    ? 'Search parsing succeeded. Use these snippets to answer directly; do not call web_search again unless the user asks for more sources.'
    : 'Search parsing did not find usable snippets. You may try one alternate query once.';
  return [
    `WEB_SEARCH_STATUS: ${status}`,
    `QUERY: ${query}`,
    `RESULT_COUNT: ${count}`,
    `INTERPRETATION_HINT: ${hint}`,
    '',
    result,
  ].join('\n');
}
