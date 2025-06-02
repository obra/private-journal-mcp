// ABOUTME: Unit tests for embedding functionality and search capabilities
// ABOUTME: Tests embedding generation, storage, and semantic search operations

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { EmbeddingService } from '../src/embeddings.js';
import { SearchService } from '../src/search.js';
import { JournalManager } from '../src/journal.js';

describe('Embedding and Search functionality', () => {
  let projectTempDir: string;
  let userTempDir: string;
  let journalManager: JournalManager;
  let searchService: SearchService;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-project-test-'));
    userTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-user-test-'));
    
    // Mock HOME environment
    originalHome = process.env.HOME;
    process.env.HOME = userTempDir;
    
    journalManager = new JournalManager(projectTempDir);
    searchService = new SearchService(projectTempDir, path.join(userTempDir, '.private-journal'));
  });

  afterEach(async () => {
    // Restore original HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    
    await fs.rm(projectTempDir, { recursive: true, force: true });
    await fs.rm(userTempDir, { recursive: true, force: true });
  });

  test('embedding service initializes and generates embeddings', async () => {
    const embeddingService = EmbeddingService.getInstance();
    
    const text = 'This is a test journal entry about TypeScript programming.';
    const embedding = await embeddingService.generateEmbedding(text);
    
    expect(embedding).toBeDefined();
    expect(Array.isArray(embedding)).toBe(true);
    expect(embedding.length).toBeGreaterThan(0);
    expect(typeof embedding[0]).toBe('number');
  }, 30000); // 30 second timeout for model loading

  test('embedding service extracts searchable text from markdown', async () => {
    const embeddingService = EmbeddingService.getInstance();
    
    const markdown = `---
title: "Test Entry"
date: 2025-05-31T12:00:00.000Z
timestamp: 1717056000000
---

## Feelings

I feel great about this feature implementation.

## Technical Insights

TypeScript interfaces are really powerful for maintaining code quality.`;

    const { text, sections } = embeddingService.extractSearchableText(markdown);
    
    expect(text).toContain('I feel great about this feature implementation');
    expect(text).toContain('TypeScript interfaces are really powerful');
    expect(text).not.toContain('title: "Test Entry"');
    expect(sections).toEqual(['Feelings', 'Technical Insights']);
  });

  test('cosine similarity calculation works correctly', async () => {
    const embeddingService = EmbeddingService.getInstance();
    
    const vector1 = [1, 0, 0];
    const vector2 = [1, 0, 0];
    const vector3 = [0, 1, 0];
    
    const similarity1 = embeddingService.cosineSimilarity(vector1, vector2);
    const similarity2 = embeddingService.cosineSimilarity(vector1, vector3);
    
    expect(similarity1).toBeCloseTo(1.0, 5); // Identical vectors
    expect(similarity2).toBeCloseTo(0.0, 5); // Orthogonal vectors
  });

  test('journal manager generates embeddings when writing thoughts', async () => {
    const thoughts = {
      feelings: 'I feel excited about implementing this search feature',
      technical_insights: 'Vector embeddings provide semantic understanding of text'
    };
    
    await journalManager.writeThoughts(thoughts);
    
    // Check that embedding files were created
    const today = new Date();
    const dateString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    // Check user directory for feelings and technical_insights
    const userDayDir = path.join(userTempDir, '.private-journal', dateString);
    const userFiles = await fs.readdir(userDayDir);
    
    const userMdFile = userFiles.find(f => f.endsWith('.md'));
    const userEmbeddingFile = userFiles.find(f => f.endsWith('.embedding'));
    
    expect(userMdFile).toBeDefined();
    expect(userEmbeddingFile).toBeDefined();
    
    if (userEmbeddingFile) {
      const embeddingContent = await fs.readFile(path.join(userDayDir, userEmbeddingFile), 'utf8');
      const embeddingData = JSON.parse(embeddingContent);
      
      expect(embeddingData.embedding).toBeDefined();
      expect(Array.isArray(embeddingData.embedding)).toBe(true);
      expect(embeddingData.text).toContain('excited about implementing');
      expect(embeddingData.sections).toContain('Feelings');
      expect(embeddingData.sections).toContain('Technical Insights');
    }
  }, 60000);

  test('search service finds semantically similar entries', async () => {
    // Write some test entries
    await journalManager.writeThoughts({
      feelings: 'I feel frustrated with debugging TypeScript errors'
    });
    
    await journalManager.writeThoughts({
      technical_insights: 'JavaScript async patterns can be tricky to understand'
    });
    
    await journalManager.writeThoughts({
      project_notes: 'The React component architecture is working well'
    });

    // Wait a moment for embeddings to be generated
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Search for similar entries
    const results = await searchService.search('feeling upset about TypeScript problems');
    
    expect(results.length).toBeGreaterThan(0);
    
    // The first result should be about TypeScript frustration
    const topResult = results[0];
    expect(topResult.text).toContain('frustrated');
    expect(topResult.text).toContain('TypeScript');
    expect(topResult.score).toBeGreaterThan(0.1);
  }, 90000);

  test('search service can filter by entry type', async () => {
    // Add project and user entries
    await journalManager.writeThoughts({
      project_notes: 'This project uses React and TypeScript'
    });
    
    await journalManager.writeThoughts({
      feelings: 'I enjoy working with modern JavaScript frameworks'
    });

    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Search only project entries
    const projectResults = await searchService.search('React TypeScript', { type: 'project' });
    const userResults = await searchService.search('React TypeScript', { type: 'user' });
    
    expect(projectResults.length).toBeGreaterThan(0);
    expect(projectResults[0].type).toBe('project');
    
    if (userResults.length > 0) {
      expect(userResults[0].type).toBe('user');
    }
  }, 90000);
});