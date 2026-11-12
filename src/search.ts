// ABOUTME: Journal search functionality with vector similarity and text matching
// ABOUTME: Provides unified search across project and user journal entries

import * as fs from 'fs/promises';
import * as path from 'path';
import { EmbeddingService, EmbeddingData } from './embeddings.js';
import { resolveUserJournalPath, resolveProjectJournalPath } from './paths.js';
import { backfillEntryFile, isJournalEntryFilename } from './entry-files.js';

export interface SearchResult {
  path: string;
  score: number;
  text: string;
  sections: string[];
  timestamp: number;
  excerpt: string;
  type: 'project' | 'user';
}

export interface RecentEntryResult {
  path: string;
  content: string;
  sections: string[];
  timestamp: number;
  type: 'project' | 'user';
}

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  sections?: string[];
  dateRange?: {
    start?: Date;
    end?: Date;
  };
  type?: 'project' | 'user' | 'both';
}

export class SearchService {
  private embeddingService: EmbeddingService;
  private projectPath: string;
  private userPath: string;

  // Read-time backfill tuning (see loadEmbeddingsFromPath). Public, mutable fields --
  // mirrors EmbeddingService.initTimeoutMs / embeddingRetryDelayMs -- so tests can shrink
  // them instead of waiting on real timers or creating hundreds of files.
  //
  // Caps how many unindexed .md files a single loadEmbeddingsFromPath call will attempt to
  // backfill. Without this, "list the last 5" pays to re-embed the entire history's worth of
  // failed entries on every call, which is exactly the wrong time to add embedding load if
  // the embedder is what's failing.
  maxBackfillPerCall = 5;
  // Minimum time to wait before retrying a file that just failed backfill, so a persistently
  // broken embedder doesn't get hammered by every list/search call. Keyed by absolute file
  // path; see recentBackfillFailures below.
  backfillBackoffMs = 5 * 60 * 1000;
  // Injectable clock so tests can simulate the backoff window elapsing without a real sleep.
  now: () => number = () => Date.now();
  private recentBackfillFailures = new Map<string, number>();

  constructor(projectPath?: string, userPath?: string) {
    this.embeddingService = EmbeddingService.getInstance();
    this.projectPath = projectPath || resolveProjectJournalPath();
    this.userPath = userPath || resolveUserJournalPath();
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const {
      limit = 10,
      minScore = 0.1,
      sections,
      dateRange,
      type = 'both'
    } = options;

    // Generate query embedding
    const queryEmbedding = await this.embeddingService.generateEmbedding(query);

    // Collect all embeddings
    const allEmbeddings: Array<EmbeddingData & { type: 'project' | 'user' }> = [];

    if (type === 'both' || type === 'project') {
      const projectEmbeddings = await this.loadEmbeddingsFromPath(this.projectPath, 'project');
      allEmbeddings.push(...projectEmbeddings);
    }

    if (type === 'both' || type === 'user') {
      const userEmbeddings = await this.loadEmbeddingsFromPath(this.userPath, 'user');
      allEmbeddings.push(...userEmbeddings);
    }

    // Filter by criteria
    const filtered = allEmbeddings.filter(embedding => {
      // Filter by sections if specified
      if (sections && sections.length > 0) {
        const hasMatchingSection = sections.some(section => 
          embedding.sections.some(embeddingSection => 
            embeddingSection.toLowerCase().includes(section.toLowerCase())
          )
        );
        if (!hasMatchingSection) return false;
      }

      // Filter by date range
      if (dateRange) {
        const entryDate = new Date(embedding.timestamp);
        if (dateRange.start && entryDate < dateRange.start) return false;
        if (dateRange.end && entryDate > dateRange.end) return false;
      }

      return true;
    });

    // Calculate similarities and sort
    const results: SearchResult[] = filtered
      .map(embedding => {
        const score = this.embeddingService.cosineSimilarity(queryEmbedding, embedding.embedding);
        const excerpt = this.generateExcerpt(embedding.text, query);
        
        return {
          path: embedding.path,
          score,
          text: embedding.text,
          sections: embedding.sections,
          timestamp: embedding.timestamp,
          excerpt,
          type: embedding.type
        };
      })
      .filter(result => result.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return results;
  }

  async listRecent(options: SearchOptions = {}): Promise<SearchResult[]> {
    const {
      limit = 10,
      type = 'both',
      dateRange
    } = options;

    const allEmbeddings: Array<EmbeddingData & { type: 'project' | 'user' }> = [];

    if (type === 'both' || type === 'project') {
      const projectEmbeddings = await this.loadEmbeddingsFromPath(this.projectPath, 'project');
      allEmbeddings.push(...projectEmbeddings);
    }

    if (type === 'both' || type === 'user') {
      const userEmbeddings = await this.loadEmbeddingsFromPath(this.userPath, 'user');
      allEmbeddings.push(...userEmbeddings);
    }

    // Filter by date range
    const filtered = dateRange ? allEmbeddings.filter(embedding => {
      const entryDate = new Date(embedding.timestamp);
      if (dateRange.start && entryDate < dateRange.start) return false;
      if (dateRange.end && entryDate > dateRange.end) return false;
      return true;
    }) : allEmbeddings;

    // Sort by timestamp (most recent first) and limit
    const results: SearchResult[] = filtered
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .map(embedding => ({
        path: embedding.path,
        score: 1, // No similarity score for recent entries
        text: embedding.text,
        sections: embedding.sections,
        timestamp: embedding.timestamp,
        excerpt: this.generateExcerpt(embedding.text, '', 150),
        type: embedding.type
      }));

    return results;
  }

  async readRecentEntries(options: { limit?: number; type?: 'project' | 'user' | 'both' } = {}): Promise<RecentEntryResult[]> {
    const { limit = 5, type = 'both' } = options;

    const recent = await this.listRecent({ limit, type });

    const results: RecentEntryResult[] = [];
    for (const entry of recent) {
      const content = await this.readEntry(entry.path);
      if (content !== null) {
        results.push({
          path: entry.path,
          content,
          sections: entry.sections,
          timestamp: entry.timestamp,
          type: entry.type,
        });
      }
    }

    return results;
  }

  async readEntry(filePath: string): Promise<string | null> {
    const resolvedPath = path.resolve(filePath);

    // Only Markdown entries under the journal directories are readable; reject
    // anything else with a clear error.
    if (path.extname(resolvedPath).toLowerCase() !== '.md') {
      throw new Error(`${resolvedPath} is not a readable journal entry`);
    }
    if (!this.isUnderJournalRoot(resolvedPath, this.journalRoots())) {
      throw new Error(`${resolvedPath} is not a readable journal entry`);
    }

    let realPath: string;
    try {
      realPath = await fs.realpath(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    // Resolve symlinks and confirm the real file is still under a journal
    // directory before reading.
    if (!this.isUnderJournalRoot(realPath, await this.realJournalRoots())) {
      throw new Error(`${resolvedPath} is not a readable journal entry`);
    }

    try {
      return await fs.readFile(realPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private journalRoots(): string[] {
    return [this.projectPath, this.userPath].map(root => path.resolve(root));
  }

  private async realJournalRoots(): Promise<string[]> {
    const roots: string[] = [];
    for (const root of this.journalRoots()) {
      try {
        roots.push(await fs.realpath(root));
      } catch {
        // A journal root that doesn't exist on disk can't contain anything.
      }
    }
    return roots;
  }

  private isUnderJournalRoot(candidate: string, roots: string[]): boolean {
    return roots.some(
      root => candidate === root || candidate.startsWith(root + path.sep)
    );
  }

  private async loadEmbeddingsFromPath(
    basePath: string, 
    type: 'project' | 'user'
  ): Promise<Array<EmbeddingData & { type: 'project' | 'user' }>> {
    const embeddings: Array<EmbeddingData & { type: 'project' | 'user' }> = [];
    // Per-call cap on read-time backfill attempts (see the reconcile step below), shared
    // across all day directories under this one basePath.
    let backfillBudget = this.maxBackfillPerCall;

    try {
      const dayDirs = await fs.readdir(basePath);
      
      for (const dayDir of dayDirs) {
        const dayPath = path.join(basePath, dayDir);
        const stat = await fs.stat(dayPath);
        
        if (!stat.isDirectory() || !dayDir.match(/^\d{4}-\d{2}-\d{2}$/)) {
          continue;
        }

        // One listing covers both what we need: the .embedding files to load, and (by
        // diffing against the .md files already in hand) which entries are missing one.
        // This keeps reconciliation free of any extra directory walk.
        const files = await fs.readdir(dayPath);
        const embeddingFiles = files.filter(file => file.endsWith('.embedding'));
        const mdFiles = files.filter(isJournalEntryFilename);

        for (const embeddingFile of embeddingFiles) {
          try {
            const embeddingPath = path.join(dayPath, embeddingFile);
            const content = await fs.readFile(embeddingPath, 'utf8');
            const embeddingData = JSON.parse(content);
            embeddings.push({ ...embeddingData, type });
          } catch (error) {
            console.error(`Failed to load embedding ${embeddingFile}:`, error);
            // Continue with other files
          }
        }

        // Reconcile: a .md file with no matching .embedding is a journal entry that was
        // written but never got indexed (e.g. the embedding step failed, even after its own
        // retry, when the entry was written). Pick those up here instead of waiting for a
        // server restart (generateMissingEmbeddings only runs at startup) -- a failure for
        // any one entry must not prevent the rest of this read from returning.
        //
        // Bounded by maxBackfillPerCall and recentBackfillFailures: without a cap, "list the
        // last 5" would try to re-embed every unindexed entry in the whole history on every
        // call, and without a backoff it would retry a file that just failed on the very next
        // call too -- both add embedding load exactly when the embedder is already failing.
        const embeddedBasenames = new Set(embeddingFiles.map(file => file.replace(/\.embedding$/, '')));
        const unindexedMdFiles = mdFiles.filter(file => !embeddedBasenames.has(file.replace(/\.md$/, '')));

        for (const mdFile of unindexedMdFiles) {
          if (backfillBudget <= 0) break;

          const mdPath = path.join(dayPath, mdFile);
          const lastFailure = this.recentBackfillFailures.get(mdPath);
          if (lastFailure !== undefined && this.now() - lastFailure < this.backfillBackoffMs) {
            continue; // failed recently -- back off instead of retrying every call
          }

          backfillBudget--;
          try {
            const result = await backfillEntryFile(this.embeddingService, mdPath, dayDir);
            if (result.indexed) {
              this.recentBackfillFailures.delete(mdPath);
              if (result.data) {
                embeddings.push({ ...result.data, type });
              }
            } else {
              this.recentBackfillFailures.set(mdPath, this.now());
            }
          } catch (error) {
            console.error(`Failed to reconcile missing embedding for ${mdPath}:`, error);
            this.recentBackfillFailures.set(mdPath, this.now());
            // Leave it unindexed for this read; a later read will retry once the backoff
            // window passes.
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.error(`Failed to read embeddings from ${basePath}:`, error);
      }
      // Return empty array if directory doesn't exist
    }

    return embeddings;
  }

  private generateExcerpt(text: string, query: string, maxLength: number = 200): string {
    if (!query || query.trim() === '') {
      return text.slice(0, maxLength) + (text.length > maxLength ? '...' : '');
    }

    const queryWords = query.toLowerCase().split(/\s+/);
    const textLower = text.toLowerCase();
    
    // Find the best position to start the excerpt
    let bestPosition = 0;
    let bestScore = 0;

    for (let i = 0; i <= text.length - maxLength; i += 20) {
      const window = textLower.slice(i, i + maxLength);
      const score = queryWords.reduce((sum, word) => {
        return sum + (window.includes(word) ? 1 : 0);
      }, 0);

      if (score > bestScore) {
        bestScore = score;
        bestPosition = i;
      }
    }

    let excerpt = text.slice(bestPosition, bestPosition + maxLength);
    if (bestPosition > 0) excerpt = '...' + excerpt;
    if (bestPosition + maxLength < text.length) excerpt += '...';

    return excerpt;
  }
}