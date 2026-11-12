// ABOUTME: Core journal writing functionality for MCP server
// ABOUTME: Handles file system operations, timestamps, and markdown formatting

import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveUserJournalPath, isSameJournalPath } from './paths.js';
import { EmbeddingService } from './embeddings.js';
import { backfillEntryFile, isJournalEntryFilename } from './entry-files.js';

// Result of a process_thoughts write. `indexed: false` means the entry was written to disk
// (the .md file exists) but the embedding step failed even after a retry, so it will not
// show up in list_recent_entries or search_journal until it's reconciled on a later read.
// `errors` carries the underlying failure message(s) for the caller to surface.
export interface WriteThoughtsResult {
  indexed: boolean;
  errors: string[];
}

export class JournalManager {
  private projectJournalPath: string;
  private userJournalPath: string;
  private embeddingService: EmbeddingService;

  constructor(projectJournalPath: string, userJournalPath?: string) {
    this.projectJournalPath = projectJournalPath;
    this.userJournalPath = userJournalPath || resolveUserJournalPath();
    this.embeddingService = EmbeddingService.getInstance();
  }

  async writeThoughts(thoughts: {
    reflections?: string;
    observations?: string;
    project_notes?: string;
    user_context?: string;
    technical_insights?: string;
    world_knowledge?: string;
  }): Promise<WriteThoughtsResult> {
    const timestamp = new Date();

    // When both journals live in one directory, keep the entry in one file.
    // Splitting it would leave two files with the same timestamp, which also
    // risks one overwriting the other if their random suffixes collide.
    if (isSameJournalPath(this.projectJournalPath, this.userJournalPath)) {
      const hasContent = Object.values(thoughts).some(value => value !== undefined);
      if (hasContent) {
        return this.writeThoughtsToLocation(thoughts, timestamp, this.projectJournalPath);
      }
      return { indexed: true, errors: [] };
    }

    // Split thoughts into project-local and user-global
    const projectThoughts = { project_notes: thoughts.project_notes };
    const userThoughts = {
      reflections: thoughts.reflections,
      observations: thoughts.observations,
      user_context: thoughts.user_context,
      technical_insights: thoughts.technical_insights,
      world_knowledge: thoughts.world_knowledge
    };

    const results: WriteThoughtsResult[] = [];
    
    // Write project notes to project directory
    if (projectThoughts.project_notes) {
      results.push(await this.writeThoughtsToLocation(projectThoughts, timestamp, this.projectJournalPath));
    }
    
    // Write user thoughts to user directory
    const hasUserContent = Object.values(userThoughts).some(value => value !== undefined);
    if (hasUserContent) {
      results.push(await this.writeThoughtsToLocation(userThoughts, timestamp, this.userJournalPath));
    }

    return {
      indexed: results.every(r => r.indexed),
      errors: results.flatMap(r => r.errors),
    };
  }

  private formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private formatTimestamp(date: Date): string {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const microseconds = String(date.getMilliseconds() * 1000 + Math.floor(Math.random() * 1000)).padStart(6, '0');
    return `${hours}-${minutes}-${seconds}-${microseconds}`;
  }

  private async writeThoughtsToLocation(
    thoughts: {
      reflections?: string;
      observations?: string;
      project_notes?: string;
      user_context?: string;
      technical_insights?: string;
      world_knowledge?: string;
    },
    timestamp: Date,
    basePath: string
  ): Promise<WriteThoughtsResult> {
    const dateString = this.formatDate(timestamp);
    const timeString = this.formatTimestamp(timestamp);
    
    const dayDirectory = path.join(basePath, dateString);
    const fileName = `${timeString}.md`;
    const filePath = path.join(dayDirectory, fileName);

    await this.ensureDirectoryExists(dayDirectory);
    
    const formattedEntry = this.formatThoughts(thoughts, timestamp);
    await fs.writeFile(filePath, formattedEntry, 'utf8');

    // Generate and save embedding. The .md write above has already succeeded by this point;
    // a failure here must not be reported as a plain success (see writeThoughts/server.ts),
    // but it also must not undo or re-attempt the .md write itself.
    const embeddingResult = await this.generateEmbeddingForEntry(filePath, formattedEntry, timestamp);
    if (embeddingResult.indexed) {
      return { indexed: true, errors: [] };
    }
    return { indexed: false, errors: [`${filePath}: ${embeddingResult.error ?? 'unknown error'}`] };
  }

  private formatThoughts(thoughts: {
    reflections?: string;
    observations?: string;
    project_notes?: string;
    user_context?: string;
    technical_insights?: string;
    world_knowledge?: string;
  }, timestamp: Date): string {
    const timeDisplay = timestamp.toLocaleTimeString('en-US', { 
      hour12: true, 
      hour: 'numeric', 
      minute: '2-digit', 
      second: '2-digit' 
    });
    const dateDisplay = timestamp.toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });

    const sections = [];
    
    if (thoughts.reflections) {
      sections.push(`## Reflections\n\n${thoughts.reflections}`);
    }

    if (thoughts.observations) {
      sections.push(`## Observations\n\n${thoughts.observations}`);
    }

    if (thoughts.project_notes) {
      sections.push(`## Project Notes\n\n${thoughts.project_notes}`);
    }
    
    if (thoughts.user_context) {
      sections.push(`## User Context\n\n${thoughts.user_context}`);
    }
    
    if (thoughts.technical_insights) {
      sections.push(`## Technical Insights\n\n${thoughts.technical_insights}`);
    }
    
    if (thoughts.world_knowledge) {
      sections.push(`## World Knowledge\n\n${thoughts.world_knowledge}`);
    }

    return `---
title: "${timeDisplay} - ${dateDisplay}"
date: ${timestamp.toISOString()}
timestamp: ${timestamp.getTime()}
---

${sections.join('\n\n')}
`;
  }

  private async generateEmbeddingForEntry(
    filePath: string,
    content: string,
    timestamp: Date
  ): Promise<{ indexed: boolean; error?: string }> {
    // Delegates to EmbeddingService, which retries once on failure. Never throws -- an
    // embedding failure must not prevent the journal entry itself from being written --
    // but the outcome is now reported back up to writeThoughts/server.ts instead of being
    // silently discarded, so a caller can tell a plain success from "written but not indexed".
    const result = await this.embeddingService.generateAndSaveEmbedding(filePath, content, timestamp);
    return { indexed: result.indexed, error: result.error };
  }

  async generateMissingEmbeddings(): Promise<number> {
    let count = 0;
    const paths = isSameJournalPath(this.projectJournalPath, this.userJournalPath)
      ? [this.projectJournalPath]
      : [this.projectJournalPath, this.userJournalPath];
    
    for (const basePath of paths) {
      try {
        const dayDirs = await fs.readdir(basePath);
        
        for (const dayDir of dayDirs) {
          const dayPath = path.join(basePath, dayDir);
          const stat = await fs.stat(dayPath);
          
          if (!stat.isDirectory() || !dayDir.match(/^\d{4}-\d{2}-\d{2}$/)) {
            continue;
          }

          const files = await fs.readdir(dayPath);
          const mdFiles = files.filter(isJournalEntryFilename);

          for (const mdFile of mdFiles) {
            const mdPath = path.join(dayPath, mdFile);
            const embeddingPath = mdPath.replace(/\.md$/, '.embedding');
            
            try {
              await fs.access(embeddingPath);
              // Embedding already exists, skip
            } catch {
              // Generate missing embedding
              console.error(`Generating missing embedding for ${mdPath}`);
              await backfillEntryFile(this.embeddingService, mdPath, dayDir);
              count++;
            }
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          console.error(`Failed to scan ${basePath} for missing embeddings:`, error);
        }
      }
    }
    
    return count;
  }

  private async ensureDirectoryExists(dirPath: string): Promise<void> {
    try {
      await fs.access(dirPath);
    } catch (error) {
      try {
        await fs.mkdir(dirPath, { recursive: true });
      } catch (mkdirError) {
        throw new Error(`Failed to create journal directory at ${dirPath}: ${mkdirError instanceof Error ? mkdirError.message : mkdirError}`);
      }
    }
  }
}