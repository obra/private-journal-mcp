// ABOUTME: Tests for the entry-filename filter (isJournalEntryFilename) in src/entry-files.ts.
// ABOUTME: Covers both direct unit checks and the two callers that rely on it -- the startup
// ABOUTME: repair (JournalManager.generateMissingEmbeddings) and the read-time backfill
// ABOUTME: (SearchService.listRecent) -- to prove a non-entry .md sitting in a day directory
// ABOUTME: with no .embedding sidecar is never mistaken for a journal entry by either path.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { isJournalEntryFilename } from '../src/entry-files';
import { EmbeddingService } from '../src/embeddings';
import { JournalManager } from '../src/journal';
import { SearchService } from '../src/search';

describe('isJournalEntryFilename', () => {
  test('accepts the exact filename shape writeThoughtsToLocation produces', () => {
    expect(isJournalEntryFilename('09-00-00-000000.md')).toBe(true);
    expect(isJournalEntryFilename('23-59-59-123456.md')).toBe(true);
  });

  test('rejects a non-entry .md file in the same directory', () => {
    expect(isJournalEntryFilename('README.md')).toBe(false);
    expect(isJournalEntryFilename('notes.md')).toBe(false);
  });

  test('rejects sidecar and temp-write files that share the base directory', () => {
    expect(isJournalEntryFilename('09-00-00-000000.embedding')).toBe(false);
    expect(isJournalEntryFilename('09-00-00-000000.md.tmp-123-456-abc')).toBe(false);
  });
});

describe('entry-filename filter integration (startup repair + read-time backfill)', () => {
  let projectTempDir: string;
  let userTempDir: string;
  let journalManager: JournalManager;
  let searchService: SearchService;
  let embeddingService: any;
  let realGenerateEmbedding: (text: string) => Promise<number[]>;

  beforeEach(async () => {
    projectTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-entry-filter-project-'));
    userTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-entry-filter-user-'));

    journalManager = new JournalManager(projectTempDir, userTempDir);
    searchService = new SearchService(projectTempDir, userTempDir);

    // Real EmbeddingService singleton, but stub generateEmbedding so these tests don't pay
    // for loading the actual model -- same technique as tests/indexing-visibility.test.ts.
    embeddingService = EmbeddingService.getInstance();
    realGenerateEmbedding = embeddingService.generateEmbedding.bind(embeddingService);
    embeddingService.generateEmbedding = async () => [1, 0, 0, 0];
  });

  afterEach(async () => {
    embeddingService.generateEmbedding = realGenerateEmbedding;
    await fs.rm(projectTempDir, { recursive: true, force: true });
    await fs.rm(userTempDir, { recursive: true, force: true });
  });

  // One day directory holding a properly-named entry and a non-entry .md, both with no
  // .embedding sidecar -- the shape that's ambiguous if the filter is ever loosened to
  // "any .md in a day dir".
  async function writeDayDirFixture(dayDirName: string): Promise<string> {
    const dayPath = path.join(userTempDir, dayDirName);
    await fs.mkdir(dayPath, { recursive: true });

    await fs.writeFile(
      path.join(dayPath, '09-00-00-000000.md'),
      '## Observations\n\nthe real journal entry\n',
      'utf8'
    );

    // Not a journal entry -- e.g. a README committed alongside exported/synced journal
    // files. No .embedding exists for it either, so it looks exactly like an entry that
    // "needs backfilling" to a filter that isn't filename-aware.
    await fs.writeFile(
      path.join(dayPath, 'README.md'),
      '# README\n\nproject documentation, not a journal entry -- do not index me\n',
      'utf8'
    );

    return dayPath;
  }

  test('startup repair (generateMissingEmbeddings) backfills the entry but skips the non-entry .md', async () => {
    const dayPath = await writeDayDirFixture('2026-02-01');

    const count = await journalManager.generateMissingEmbeddings();

    expect(count).toBe(1);

    const entryHasEmbedding = await fs
      .access(path.join(dayPath, '09-00-00-000000.embedding'))
      .then(() => true, () => false);
    const readmeHasEmbedding = await fs
      .access(path.join(dayPath, 'README.embedding'))
      .then(() => true, () => false);

    expect(entryHasEmbedding).toBe(true);
    expect(readmeHasEmbedding).toBe(false);
  });

  test('read-time backfill (listRecent) returns the entry, not the non-entry .md, and does not index it', async () => {
    const dayPath = await writeDayDirFixture('2026-02-02');

    const recent = await searchService.listRecent({ type: 'user', limit: 10 });

    expect(recent).toHaveLength(1);
    expect(recent[0].text).toContain('the real journal entry');
    expect(recent.some(r => r.text.includes('do not index me'))).toBe(false);

    const entryHasEmbedding = await fs
      .access(path.join(dayPath, '09-00-00-000000.embedding'))
      .then(() => true, () => false);
    const readmeHasEmbedding = await fs
      .access(path.join(dayPath, 'README.embedding'))
      .then(() => true, () => false);

    expect(entryHasEmbedding).toBe(true);
    expect(readmeHasEmbedding).toBe(false);
  });
});
