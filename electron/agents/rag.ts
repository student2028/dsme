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
  mtime: number;       // last modified timestamp (ms)
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
          const s = await stat(filePath);
          const relPath = relative(cwd, filePath);
          const tokens = this.tokenize(content + ' ' + relPath);
          const tf = this.computeTF(tokens);
          
          // Track document frequency
          const uniqueTokens = new Set(tokens);
          for (const token of uniqueTokens) {
            docFreq.set(token, (docFreq.get(token) || 0) + 1);
          }

          this.files.push({ path: relPath, content, tokens, tfidf: tf, mtime: s.mtimeMs });
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
   * Incremental update — only re-index files that changed since last index.
   * Much faster than full re-index for typical edit-compile-test cycles.
   */
  async update(): Promise<{ added: number; updated: number; removed: number }> {
    if (!this.indexed || this.indexing || !this.cwd) return { added: 0, updated: 0, removed: 0 };
    this.indexing = true;
    let added = 0, updated = 0, removed = 0;

    try {
      const currentFiles = await this.walkDir(this.cwd);
      const currentSet = new Set(currentFiles.map(f => relative(this.cwd, f)));
      const existingMap = new Map(this.files.map(f => [f.path, f]));

      // Remove deleted files
      const beforeCount = this.files.length;
      this.files = this.files.filter(f => currentSet.has(f.path));
      removed = beforeCount - this.files.length;

      // Check for new/modified files
      for (const filePath of currentFiles.slice(0, MAX_FILES)) {
        const relPath = relative(this.cwd, filePath);
        try {
          const s = await stat(filePath);
          const existing = existingMap.get(relPath);

          if (existing && s.mtimeMs <= existing.mtime) continue; // Unchanged

          const content = await readFile(filePath, 'utf-8');
          const tokens = this.tokenize(content + ' ' + relPath);
          const tf = this.computeTF(tokens);

          if (existing) {
            // Update in place
            existing.content = content;
            existing.tokens = tokens;
            existing.tfidf = tf;
            existing.mtime = s.mtimeMs;
            updated++;
          } else {
            // New file
            this.files.push({ path: relPath, content, tokens, tfidf: tf, mtime: s.mtimeMs });
            added++;
          }
        } catch {}
      }

      // Recompute IDF if files changed
      if (added > 0 || removed > 0 || updated > 0) {
        this.recomputeIDF();
        console.log(`[RAG] Incremental update: +${added} ~${updated} -${removed} (total: ${this.files.length})`);
      }

      return { added, updated, removed };
    } finally {
      this.indexing = false;
    }
  }

  /** Recompute IDF and TF-IDF weights for all files */
  private recomputeIDF() {
    const docFreq = new Map<string, number>();
    for (const file of this.files) {
      const uniqueTokens = new Set(file.tokens);
      for (const token of uniqueTokens) {
        docFreq.set(token, (docFreq.get(token) || 0) + 1);
      }
    }
    this.idf.clear();
    const N = this.files.length;
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
    }
    for (const file of this.files) {
      const tf = this.computeTF(file.tokens);
      for (const [term, v] of tf) {
        file.tfidf.set(term, v * (this.idf.get(term) || 1));
      }
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

  private async walkDir(dir: string, depth = 0): Promise<string[]> {
    if (depth > 10) return []; // Prevent excessive recursion in deep trees
    const results: string[] = [];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(entry.name)) {
            const sub = await this.walkDir(fullPath, depth + 1);
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
    // Safe max: avoid Math.max(...spread) stack overflow for large token sets
    let maxFreq = 1;
    for (const c of freq.values()) {
      if (c > maxFreq) maxFreq = c;
    }
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

    // Pre-tokenize every line once to avoid O(N*W*T) re-tokenization
    const querySet = new Set(queryTokens);
    const lineScores = lines.map(line => {
      let s = 0;
      for (const t of this.tokenize(line)) {
        if (querySet.has(t)) s++;
      }
      return s;
    });

    // Sliding window over pre-computed line scores
    let bestStart = 0, bestScore = -1;
    let windowScore = 0;
    for (let i = 0; i < SNIPPET_LINES && i < lines.length; i++) {
      windowScore += lineScores[i];
    }
    if (windowScore > bestScore) { bestScore = windowScore; bestStart = 0; }

    for (let i = 1; i <= lines.length - SNIPPET_LINES; i++) {
      windowScore -= lineScores[i - 1];
      windowScore += lineScores[i + SNIPPET_LINES - 1];
      if (windowScore > bestScore) {
        bestScore = windowScore;
        bestStart = i;
      }
    }

    const snippet = lines.slice(bestStart, bestStart + SNIPPET_LINES).join('\n');
    const prefix = bestStart > 0 ? `// ... (line ${bestStart + 1})\n` : '';
    const suffix = bestStart + SNIPPET_LINES < lines.length ? '\n// ...' : '';
    return prefix + snippet + suffix;
  }
}
