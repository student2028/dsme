/**
 * DSME RAG Engine — Lightweight project-aware context retrieval
 * 
 * Uses TF-IDF cosine similarity for fast, zero-dependency code search.
 * Indexes project files on startup and provides relevant code snippets
 * to inject into the AI system prompt for every query.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { join, extname, relative } from 'path';

// ── Types ──
interface IndexedFile {
  path: string;        // relative path
  content: string;     // raw file content
  tokens: string[];    // tokenized words
  tfidf: Map<string, number>; // TF-IDF weights
}

interface SearchResult {
  path: string;
  score: number;
  snippet: string;
}

// ── Config ──
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.kt',
  '.swift', '.c', '.cpp', '.h', '.css', '.html', '.json', '.yaml',
  '.yml', '.md', '.toml', '.sh', '.sql', '.vue', '.svelte',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'build', '.next',
  '.vscode', '.idea', '__pycache__', '.cache', 'coverage',
]);

const MAX_FILE_SIZE = 100 * 1024; // 100KB
const MAX_FILES = 500;
const SNIPPET_LINES = 30;

// ── RAG Engine ──
export class RAGEngine {
  private files: IndexedFile[] = [];
  private idf: Map<string, number> = new Map();
  private indexed = false;
  private indexing = false;
  private cwd = '';

  /**
   * Index all project files (call once on startup or workspace change)
   */
  async index(cwd: string): Promise<number> {
    if (this.indexing) return this.files.length;
    this.indexing = true;
    this.cwd = cwd;
    this.files = [];
    this.idf.clear();

    try {
      const allFiles = await this.walkDir(cwd);
      const docFreq = new Map<string, number>();

      for (const filePath of allFiles.slice(0, MAX_FILES)) {
        try {
          const content = await readFile(filePath, 'utf-8');
          const relPath = relative(cwd, filePath);
          const tokens = this.tokenize(content + ' ' + relPath);
          const tf = this.computeTF(tokens);
          
          // Track document frequency
          const uniqueTokens = new Set(tokens);
          for (const token of uniqueTokens) {
            docFreq.set(token, (docFreq.get(token) || 0) + 1);
          }

          this.files.push({ path: relPath, content, tokens, tfidf: tf });
        } catch {
          // Skip unreadable files
        }
      }

      // Compute IDF
      const N = this.files.length;
      for (const [term, df] of docFreq) {
        this.idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
      }

      // Compute TF-IDF for each file
      for (const file of this.files) {
        for (const [term, tf] of file.tfidf) {
          file.tfidf.set(term, tf * (this.idf.get(term) || 1));
        }
      }

      this.indexed = true;
      console.log(`[RAG] Indexed ${this.files.length} files from ${cwd}`);
      return this.files.length;

    } finally {
      this.indexing = false;
    }
  }

  /**
   * Retrieve relevant code snippets for a query
   */
  search(query: string, topK = 5): SearchResult[] {
    if (!this.indexed || this.files.length === 0) return [];

    const queryTokens = this.tokenize(query);
    const queryTF = this.computeTF(queryTokens);
    const queryVec = new Map<string, number>();
    for (const [term, tf] of queryTF) {
      queryVec.set(term, tf * (this.idf.get(term) || 1));
    }

    // Cosine similarity against all files
    const scores: { idx: number; score: number }[] = [];
    for (let i = 0; i < this.files.length; i++) {
      const score = this.cosineSimilarity(queryVec, this.files[i].tfidf);
      if (score > 0.01) {
        scores.push({ idx: i, score });
      }
    }

    // Sort by score, take top K
    scores.sort((a, b) => b.score - a.score);
    
    return scores.slice(0, topK).map(({ idx, score }) => {
      const file = this.files[idx];
      // Extract the most relevant snippet
      const snippet = this.extractSnippet(file.content, queryTokens);
      return { path: file.path, score, snippet };
    });
  }

  /**
   * Build context string for injection into system prompt
   */
  buildContext(query: string): string {
    const results = this.search(query, 5);
    if (results.length === 0) return '';

    let context = '\n\n## Relevant Project Code (auto-retrieved)\n';
    for (const r of results) {
      context += `\n### ${r.path} (relevance: ${(r.score * 100).toFixed(0)}%)\n`;
      context += '```\n' + r.snippet + '\n```\n';
    }
    return context;
  }

  get fileCount(): number { return this.files.length; }
  get isReady(): boolean { return this.indexed; }

  // ── Private helpers ──

  private async walkDir(dir: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name)) {
            const sub = await this.walkDir(fullPath);
            results.push(...sub);
          }
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (CODE_EXTENSIONS.has(ext)) {
            try {
              const s = await stat(fullPath);
              if (s.size <= MAX_FILE_SIZE) {
                results.push(fullPath);
              }
            } catch {}
          }
        }
      }
    } catch {}
    return results;
  }

  private tokenize(text: string): string[] {
    // Split camelCase/PascalCase: 'MemoizedMarkdown' → 'Memoized Markdown'
    const expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2')
                         .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return expanded
      .toLowerCase()
      .replace(/[^a-z0-9_\u4e00-\u9fff]+/g, ' ')
      .split(/[_\s]+/)
      .filter(t => t.length >= 2 && t.length <= 50);
  }

  private computeTF(tokens: string[]): Map<string, number> {
    const freq = new Map<string, number>();
    for (const t of tokens) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
    const maxFreq = Math.max(...freq.values(), 1);
    const tf = new Map<string, number>();
    for (const [term, count] of freq) {
      tf.set(term, 0.5 + 0.5 * (count / maxFreq)); // Augmented TF
    }
    return tf;
  }

  private cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0, normA = 0, normB = 0;
    for (const [term, va] of a) {
      const vb = b.get(term) || 0;
      dot += va * vb;
      normA += va * va;
    }
    for (const [, vb] of b) {
      normB += vb * vb;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private extractSnippet(content: string, queryTokens: string[]): string {
    const lines = content.split('\n');
    if (lines.length <= SNIPPET_LINES) return content;

    // Score each line window by query token density
    const querySet = new Set(queryTokens);
    let bestStart = 0, bestScore = -1;

    for (let i = 0; i <= lines.length - SNIPPET_LINES; i++) {
      let score = 0;
      for (let j = i; j < i + SNIPPET_LINES; j++) {
        const lineTokens = this.tokenize(lines[j]);
        for (const t of lineTokens) {
          if (querySet.has(t)) score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestStart = i;
      }
    }

    const snippet = lines.slice(bestStart, bestStart + SNIPPET_LINES).join('\n');
    const prefix = bestStart > 0 ? `// ... (line ${bestStart + 1})\n` : '';
    const suffix = bestStart + SNIPPET_LINES < lines.length ? '\n// ...' : '';
    return prefix + snippet + suffix;
  }
}
