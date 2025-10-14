// ABOUTME: Semantic search functionality for journal entries using embeddings
// ABOUTME: Provides natural language search across journal content

import * as fs from 'fs/promises';
import * as path from 'path';
import { EmbeddingService, EmbeddingData } from './embeddings.js';
import { resolveUserJournalPath, resolveProjectJournalPath } from './paths.js';

export interface SearchResult {
  path: string;
  score: number;
  text: string;
  sections: string[];
  timestamp: number;
  excerpt: string;
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

  async readEntry(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as any)?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
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
      if ((error as any)?.code !== 'ENOENT') {
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