// ABOUTME: Unit tests for embedding functionality and search capabilities
// ABOUTME: Tests embedding generation, storage, and semantic search operations

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { EmbeddingService } from '../src/embeddings';
import { SearchService } from '../src/search';
import { JournalManager } from '../src/journal';

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

## Reflections

I feel great about this feature implementation.

## Technical Insights

TypeScript interfaces are really powerful for maintaining code quality.`;

    const { text, sections } = embeddingService.extractSearchableText(markdown);

    expect(text).toContain('I feel great about this feature implementation');
    expect(text).toContain('TypeScript interfaces are really powerful');
    expect(text).not.toContain('title: "Test Entry"');
    expect(sections).toEqual(['Reflections', 'Technical Insights']);
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
      reflections: 'I feel excited about implementing this search feature',
      technical_insights: 'Vector embeddings provide semantic understanding of text'
    };

    await journalManager.writeThoughts(thoughts);

    // Check that embedding files were created
    const today = new Date();
    const dateString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // Check user directory for reflections and technical_insights
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
      expect(embeddingData.sections).toContain('Reflections');
      expect(embeddingData.sections).toContain('Technical Insights');
    }
  }, 60000);

  test('search service finds semantically similar entries', async () => {
    // Write some test entries
    await journalManager.writeThoughts({
      reflections: 'I feel frustrated with debugging TypeScript errors'
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

    // The TypeScript frustration entry should appear in results
    const frustrationResult = results.find(r => r.text.includes('frustrated'));
    expect(frustrationResult).toBeDefined();
    expect(frustrationResult!.text).toContain('TypeScript');
    expect(frustrationResult!.score).toBeGreaterThan(0.1);
  }, 90000);

  test('search service can filter by entry type', async () => {
    // Add project and user entries
    await journalManager.writeThoughts({
      project_notes: 'This project uses React and TypeScript'
    });
    
    await journalManager.writeThoughts({
      reflections: 'I enjoy working with modern JavaScript frameworks'
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

  describe('readRecentEntries', () => {
    test('returns full content of the N most recent entries', async () => {
      // Write 3 entries with slight delays so timestamps differ
      await journalManager.writeThoughts({
        project_notes: 'First entry about architecture'
      });
      await new Promise(resolve => setTimeout(resolve, 50));

      await journalManager.writeThoughts({
        project_notes: 'Second entry about testing'
      });
      await new Promise(resolve => setTimeout(resolve, 50));

      await journalManager.writeThoughts({
        project_notes: 'Third entry about deployment'
      });

      const results = await searchService.readRecentEntries({ limit: 2 });

      expect(results).toHaveLength(2);
      // Most recent first
      expect(results[0].content).toContain('Third entry about deployment');
      expect(results[1].content).toContain('Second entry about testing');
      // Each result should have path and timestamp
      expect(results[0].path).toBeDefined();
      expect(results[0].timestamp).toBeGreaterThan(0);
    }, 60000);

    test('defaults to 5 entries', async () => {
      // Write 7 entries
      for (let i = 1; i <= 7; i++) {
        await journalManager.writeThoughts({
          project_notes: `Entry number ${i}`
        });
        if (i < 7) await new Promise(resolve => setTimeout(resolve, 50));
      }

      const results = await searchService.readRecentEntries();

      expect(results).toHaveLength(5);
      // Most recent first
      expect(results[0].content).toContain('Entry number 7');
      expect(results[4].content).toContain('Entry number 3');
    }, 90000);

    test('returns fewer entries when fewer exist', async () => {
      await journalManager.writeThoughts({
        project_notes: 'Only entry'
      });

      const results = await searchService.readRecentEntries({ limit: 5 });

      expect(results).toHaveLength(1);
      expect(results[0].content).toContain('Only entry');
    }, 60000);

    test('returns empty array when no entries exist', async () => {
      const results = await searchService.readRecentEntries();

      expect(results).toHaveLength(0);
    });
  });

  describe('readEntry', () => {
    test('reads a journal entry', async () => {
      const entryPath = path.join(projectTempDir, '2025-05-31', '12-00-00-000000.md');
      await fs.mkdir(path.dirname(entryPath), { recursive: true });
      await fs.writeFile(entryPath, '# real journal entry', 'utf8');

      const content = await searchService.readEntry(entryPath);

      expect(content).toBe('# real journal entry');
    });

    test('returns null when the entry does not exist', async () => {
      const missing = path.join(projectTempDir, '2025-05-31', 'does-not-exist.md');

      const content = await searchService.readEntry(missing);

      expect(content).toBeNull();
    });

    test('rejects a path outside the journal directories', async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-other-test-'));
      const otherFile = path.join(outsideDir, 'other.md');
      await fs.writeFile(otherFile, 'other file contents', 'utf8');

      try {
        await expect(searchService.readEntry(otherFile)).rejects.toThrow(
          /not a readable journal entry/
        );
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    test('rejects a path that resolves outside the journal directories', async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-other-test-'));
      const otherFile = path.join(outsideDir, 'other.md');
      await fs.writeFile(otherFile, 'other file contents', 'utf8');
      // Built with Array.join (not path.join) so the literal '..' reaches
      // readEntry unnormalized.
      const unnormalizedPath = [projectTempDir, '..', path.basename(outsideDir), 'other.md'].join(path.sep);

      try {
        await expect(searchService.readEntry(unnormalizedPath)).rejects.toThrow(
          /not a readable journal entry/
        );
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    test('rejects a non-Markdown path', async () => {
      const otherFile = path.join(projectTempDir, 'notes.txt');
      await fs.writeFile(otherFile, 'plain text', 'utf8');

      await expect(searchService.readEntry(otherFile)).rejects.toThrow(
        /not a readable journal entry/
      );
    });

    test('rejects a symlink that resolves outside the journal directories', async () => {
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-link-test-'));
      const otherFile = path.join(outsideDir, 'other.md');
      await fs.writeFile(otherFile, 'other file contents', 'utf8');

      const dayDir = path.join(projectTempDir, '2025-05-31');
      await fs.mkdir(dayDir, { recursive: true });
      const linkPath = path.join(dayDir, 'link.md');
      try {
        await fs.symlink(otherFile, linkPath);
      } catch (error) {
        // Windows only allows symlinks with admin rights or Developer Mode on.
        if ((error as NodeJS.ErrnoException)?.code === 'EPERM') {
          await fs.rm(outsideDir, { recursive: true, force: true });
          return;
        }
        throw error;
      }

      try {
        await expect(searchService.readEntry(linkPath)).rejects.toThrow(/not a readable journal entry/);
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  describe('initialization timeout', () => {
    let originalPipelineMock: jest.Mock;

    beforeEach(() => {
      // Reset the singleton so we get a fresh instance
      EmbeddingService.resetInstance();
      // Save the original mock
      const transformers = require('@xenova/transformers');
      originalPipelineMock = transformers.pipeline;
    });

    afterEach(() => {
      // Restore the original mock
      const transformers = require('@xenova/transformers');
      transformers.pipeline = originalPipelineMock;
      // Reset singleton for other tests
      EmbeddingService.resetInstance();
    });

    test('times out if model loading hangs', async () => {
      // Override pipeline mock to never resolve
      const transformers = require('@xenova/transformers');
      transformers.pipeline = jest.fn(() => new Promise(() => {}));

      const service = EmbeddingService.getInstance();
      service.initTimeoutMs = 100; // 100ms for fast test

      await expect(service.generateEmbedding('test'))
        .rejects.toThrow(/timed out/i);
    });

    test('can retry after timeout', async () => {
      const transformers = require('@xenova/transformers');

      // First call: hang forever
      transformers.pipeline = jest.fn(() => new Promise(() => {}));

      const service = EmbeddingService.getInstance();
      service.initTimeoutMs = 100;

      await expect(service.generateEmbedding('test'))
        .rejects.toThrow(/timed out/i);

      // Second call: succeed
      transformers.pipeline = originalPipelineMock;
      service.initTimeoutMs = 30_000;

      const embedding = await service.generateEmbedding('retry test');
      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding.length).toBeGreaterThan(0);
    });
  });
});