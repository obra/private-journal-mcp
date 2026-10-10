// ABOUTME: Journal search functionality with vector similarity and text matching
// ABOUTME: Provides unified search across project and user journal entries

import * as fs from 'fs/promises';
import * as path from 'path';
import { EmbeddingService, EmbeddingData } from './embeddings.js';
import { resolveUserJournalPath, resolveProjectJournalPath, isSameJournalPath } from './paths.js';

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

    const allEmbeddings = await this.loadEmbeddings(type);

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

    const allEmbeddings = await this.loadEmbeddings(type);

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

  private async loadEmbeddings(
    type: 'project' | 'user' | 'both'
  ): Promise<Array<EmbeddingData & { type: 'project' | 'user' }>> {
    const embeddings: Array<EmbeddingData & { type: 'project' | 'user' }> = [];

    if (type === 'both' || type === 'project') {
      embeddings.push(...await this.loadEmbeddingsFromPath(this.projectPath, 'project'));
    }

    // When both journals live in one directory, it was already loaded above;
    // loading it again would return every entry twice.
    const alreadyLoaded = type === 'both' && isSameJournalPath(this.projectPath, this.userPath);
    if ((type === 'both' || type === 'user') && !alreadyLoaded) {
      embeddings.push(...await this.loadEmbeddingsFromPath(this.userPath, 'user'));
    }

    return embeddings;
  }

  private async loadEmbeddingsFromPath(
    basePath: string, 
    type: 'project' | 'user'
  ): Promise<Array<EmbeddingData & { type: 'project' | 'user' }>> {
    const embeddings: Array<EmbeddingData & { type: 'project' | 'user' }> = [];

    try {
      const dayDirs = await fs.readdir(basePath);
      
      for (const dayDir of dayDirs) {
        const dayPath = path.join(basePath, dayDir);
        const stat = await fs.stat(dayPath);
        
        if (!stat.isDirectory() || !dayDir.match(/^\d{4}-\d{2}-\d{2}$/)) {
          continue;
        }

        const files = await fs.readdir(dayPath);
        const embeddingFiles = files.filter(file => file.endsWith('.embedding'));

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