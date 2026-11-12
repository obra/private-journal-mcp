// ABOUTME: Local embedding service using transformers for semantic journal search
// ABOUTME: Provides text embedding generation and similarity computation utilities

// `@xenova/transformers` (and its onnxruntime-web dep) is heavy enough at
// ESM-load time that on cold cache + recent Node releases the synchronous
// source-loader has been observed to ETIMEDOUT during `getSourceSync`,
// crashing the MCP server before it can respond to the initialize
// handshake. The actual `pipeline` symbol is only needed inside
// `doInitialize()`, so we type-only-import it here and use a dynamic
// import at call time. That keeps the hot path of starting the server
// (and serving every non-search tool) free of the transformers module
// graph entirely.
import type { FeatureExtractionPipeline } from '@xenova/transformers';
import * as fs from 'fs/promises';

export interface EmbeddingData {
  embedding: number[];
  text: string;
  sections: string[];
  timestamp: number;
  path: string;
}

// Result of attempting to index a journal entry for list_recent_entries / search_journal.
// `indexed: false` means the .md file exists on disk but has no .embedding sidecar, so the
// entry won't show up in either tool until it's reconciled (see SearchService) or the write
// is retried.
export interface EmbeddingWriteResult {
  indexed: boolean;
  error?: string;
  data?: EmbeddingData;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class EmbeddingService {
  private static instance: EmbeddingService;
  private extractor: FeatureExtractionPipeline | null = null;
  private readonly modelName = 'Xenova/all-MiniLM-L6-v2';
  private initPromise: Promise<void> | null = null;
  initTimeoutMs = 30_000;
  // One short retry before an entry is reported as unindexed. Covers transient failures
  // (model init timeout, momentary resource contention from concurrent journal writes)
  // without masking a persistently broken embedding pipeline.
  embeddingRetryDelayMs = 200;

  private constructor() {}

  static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  static resetInstance(): void {
    EmbeddingService.instance = undefined as unknown as EmbeddingService;
  }

  async initialize(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(
        `Model loading timed out after ${this.initTimeoutMs / 1000}s. ` +
        `This may be caused by stale lock files. ` +
        `Try: rm -rf ~/.cache/huggingface/hub/.locks/`
      )), this.initTimeoutMs);
    });
    try {
      console.error('Loading embedding model...');
      // Dynamic import — the @xenova/transformers module graph is only
      // loaded the first time someone actually asks for an embedding.
      const { pipeline } = await import('@xenova/transformers');
      this.extractor = await Promise.race([
        pipeline('feature-extraction', this.modelName) as unknown as Promise<FeatureExtractionPipeline>,
        timeoutPromise,
      ]);
      console.error('Embedding model loaded successfully');
    } catch (error) {
      this.initPromise = null; // Allow retry on next call
      console.error('Failed to load embedding model:', error);
      throw error;
    } finally {
      clearTimeout(timeoutId!);
    }
  }

  async generateEmbedding(text: string): Promise<number[]> {
    if (!this.extractor) {
      await this.initialize();
    }

    if (!this.extractor) {
      throw new Error('Embedding model not initialized');
    }

    try {
      const result = await this.extractor(text, { pooling: 'mean', normalize: true });
      return Array.from(result.data);
    } catch (error) {
      console.error('Failed to generate embedding:', error);
      throw error;
    }
  }

  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new Error('Vectors must have same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Writes via a temp file in the same directory, then renames over the real path. rename()
  // is atomic on the same filesystem, so a concurrent reader (the read-time backfill in
  // SearchService can run alongside the startup repair, or alongside another write, all in
  // one process per session) never observes a partially-written .embedding file.
  async saveEmbedding(filePath: string, embeddingData: EmbeddingData): Promise<void> {
    const embeddingPath = filePath.replace(/\.md$/, '.embedding');
    const tempPath = `${embeddingPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tempPath, JSON.stringify(embeddingData, null, 2), 'utf8');
    await fs.rename(tempPath, embeddingPath);
  }

  // Generates and persists the .embedding sidecar for a journal entry, retrying once after
  // a short delay on failure. Never throws: callers (JournalManager on write, SearchService
  // on read-time reconciliation) need to keep going -- an entry that can't be indexed should
  // still be reported as written, or should simply stay unindexed for a read-time retry,
  // rather than aborting the write or the read.
  async generateAndSaveEmbedding(
    filePath: string,
    content: string,
    timestamp: Date
  ): Promise<EmbeddingWriteResult> {
    const build = async (): Promise<EmbeddingData | null> => {
      const { text, sections } = this.extractSearchableText(content);
      if (text.trim().length === 0) {
        return null; // Nothing to index for an entry with no body text.
      }
      const embedding = await this.generateEmbedding(text);
      return { embedding, text, sections, timestamp: timestamp.getTime(), path: filePath };
    };

    try {
      const data = await build();
      if (data) await this.saveEmbedding(filePath, data);
      return { indexed: true, data: data ?? undefined };
    } catch (firstError) {
      console.error(`Failed to generate embedding for ${filePath}, retrying once:`, firstError);
      await delay(this.embeddingRetryDelayMs);
      try {
        const data = await build();
        if (data) await this.saveEmbedding(filePath, data);
        return { indexed: true, data: data ?? undefined };
      } catch (secondError) {
        const message = secondError instanceof Error ? secondError.message : String(secondError);
        console.error(`Failed to generate embedding for ${filePath} after retry:`, secondError);
        return { indexed: false, error: message };
      }
    }
  }

  async loadEmbedding(filePath: string): Promise<EmbeddingData | null> {
    const embeddingPath = filePath.replace(/\.md$/, '.embedding');
    
    try {
      const content = await fs.readFile(embeddingPath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null; // File doesn't exist
      }
      throw error;
    }
  }

  extractSearchableText(markdownContent: string): { text: string; sections: string[] } {
    // Remove YAML frontmatter
    const withoutFrontmatter = markdownContent.replace(/^---\n.*?\n---\n/s, '');
    
    // Extract sections
    const sections: string[] = [];
    const sectionMatches = withoutFrontmatter.match(/^## (.+)$/gm);
    if (sectionMatches) {
      sections.push(...sectionMatches.map(match => match.replace('## ', '')));
    }

    // Clean up markdown for embedding
    const cleanText = withoutFrontmatter
      .replace(/^## .+$/gm, '') // Remove section headers
      .replace(/\n{3,}/g, '\n\n') // Normalize whitespace
      .trim();

    return {
      text: cleanText,
      sections
    };
  }
}