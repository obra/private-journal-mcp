// ABOUTME: Regression tests for the "write succeeds, entry never shows up" bug.
// ABOUTME: Covers retry-on-write, honest reporting when indexing fails, and read-time reconcile.
//
// NOTE: results from writeThoughts() and the EmbeddingService retry knob are read through
// `any` on purpose. On main, writeThoughts() returns void and EmbeddingService has no
// embeddingRetryDelayMs/generateAndSaveEmbedding -- typing these strictly would make the
// test suite fail to *compile* against main, hiding the actual regression (the entry
// silently going missing) behind an unrelated type error. Going through `any` lets these
// tests run against both main and the fix, and fail for the real reason on main: the
// resulting value is undefined/missing fields, and the entry really isn't indexed.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { EmbeddingService } from '../src/embeddings';
import { JournalManager } from '../src/journal';
import { SearchService } from '../src/search';

describe('embedding indexing visibility', () => {
  let projectTempDir: string;
  let userTempDir: string;
  let journalManager: JournalManager;
  let searchService: SearchService;
  let embeddingService: any;
  let realGenerateEmbedding: (text: string) => Promise<number[]>;

  beforeEach(async () => {
    projectTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-project-test-'));
    userTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-user-test-'));

    journalManager = new JournalManager(projectTempDir, userTempDir);
    searchService = new SearchService(projectTempDir, userTempDir);

    embeddingService = EmbeddingService.getInstance();
    embeddingService.embeddingRetryDelayMs = 1; // keep the retry fast in tests (no-op on main)
    realGenerateEmbedding = embeddingService.generateEmbedding.bind(embeddingService);
  });

  afterEach(async () => {
    embeddingService.generateEmbedding = realGenerateEmbedding;
    await fs.rm(projectTempDir, { recursive: true, force: true });
    await fs.rm(userTempDir, { recursive: true, force: true });
  });

  async function listUserDayFiles(): Promise<string[]> {
    const dayDirs = await fs.readdir(userTempDir);
    const out: string[] = [];
    for (const dayDir of dayDirs) {
      const dayPath = path.join(userTempDir, dayDir);
      if (!(await fs.stat(dayPath)).isDirectory()) continue;
      out.push(...(await fs.readdir(dayPath)).map(f => path.join(dayDir, f)));
    }
    return out;
  }

  // (a) embedding throws once, retry succeeds -> entry shows up in listRecent.
  test('a transient embedding failure is retried and the entry becomes visible', async () => {
    let calls = 0;
    embeddingService.generateEmbedding = async (text: string) => {
      calls++;
      if (calls === 1) throw new Error('simulated transient failure');
      return realGenerateEmbedding(text);
    };

    const result: any = await journalManager.writeThoughts({ observations: 'retry should rescue this entry' });

    expect(result?.indexed).toBe(true);
    expect(result?.errors ?? []).toEqual([]);
    expect(calls).toBe(2); // first call failed, retry succeeded

    const recent = await searchService.listRecent({ type: 'user', limit: 10 });
    expect(recent).toHaveLength(1);
    expect(recent[0].text).toContain('retry should rescue this entry');
  });

  // (b) embedding always throws -> write must not report plain success, and the .md is
  // still on disk (no data loss).
  test('a persistent embedding failure is reported honestly, not as plain success', async () => {
    embeddingService.generateEmbedding = async () => {
      throw new Error('simulated persistent failure');
    };

    const result: any = await journalManager.writeThoughts({ observations: 'this entry cannot be indexed' });

    expect(result?.indexed).toBe(false);
    expect(result?.errors?.length ?? 0).toBeGreaterThan(0);
    expect(String(result?.errors?.[0] ?? '')).toContain('simulated persistent failure');

    // The .md write itself must have succeeded -- this is a visibility bug, not data loss.
    const files = await listUserDayFiles();
    const mdFiles = files.filter(f => f.endsWith('.md'));
    const embeddingFiles = files.filter(f => f.endsWith('.embedding'));
    expect(mdFiles).toHaveLength(1);
    expect(embeddingFiles).toHaveLength(0);

    const content = await fs.readFile(path.join(userTempDir, mdFiles[0]), 'utf8');
    expect(content).toContain('this entry cannot be indexed');

    // And, before reconciliation, the entry is invisible to list_recent_entries. (Not
    // asserting on search_journal here: it also needs to embed the query text itself, which
    // is unrelated to indexing the entry and is out of scope for this fix.)
    const recent = await searchService.listRecent({ type: 'user', limit: 10 });
    expect(recent).toHaveLength(0);
  });

  // (c) a .md file with no .embedding sidecar (e.g. left behind by the failure in (b), or
  // written by another process entirely) is picked up by listRecent/search on the next read,
  // without requiring a server restart.
  test('a .md file lacking an .embedding sidecar is reconciled on read', async () => {
    const dayDir = path.join(userTempDir, '2026-01-01');
    await fs.mkdir(dayDir, { recursive: true });
    const mdPath = path.join(dayDir, '12-00-00-000000.md');
    await fs.writeFile(
      mdPath,
      '---\ntitle: "test"\ndate: 2026-01-01T12:00:00.000Z\ntimestamp: 1767268800000\n---\n\n' +
        '## Observations\n\norphaned entry with no embedding sidecar\n',
      'utf8'
    );

    // Confirm the setup: no .embedding exists yet.
    expect(await fs.readdir(dayDir)).toEqual(['12-00-00-000000.md']);

    const recent = await searchService.listRecent({ type: 'user', limit: 10 });
    expect(recent).toHaveLength(1);
    expect(recent[0].text).toContain('orphaned entry with no embedding sidecar');

    // The reconcile step should also have written the sidecar so subsequent reads are cheap.
    const filesAfter = await fs.readdir(dayDir);
    expect(filesAfter).toContain('12-00-00-000000.embedding');

    const found = await searchService.search('orphaned entry', { type: 'user', minScore: 0 });
    expect(found.length).toBeGreaterThan(0);
  });

  // A reconcile failure must not break the read -- other entries should still come back.
  test('a reconcile failure for one orphaned entry does not break the read for others', async () => {
    const dayDir = path.join(userTempDir, '2026-01-02');
    await fs.mkdir(dayDir, { recursive: true });
    await fs.writeFile(
      path.join(dayDir, '12-00-00-000000.md'),
      '---\ntitle: "test"\ndate: 2026-01-02T12:00:00.000Z\ntimestamp: 1767355200000\n---\n\n' +
        '## Observations\n\nentry whose reconcile will fail\n',
      'utf8'
    );

    const goodResult: any = await journalManager.writeThoughts({ observations: 'entry that indexes fine' });
    expect(goodResult?.indexed ?? true).toBe(true);

    embeddingService.generateEmbedding = async () => {
      throw new Error('simulated reconcile failure');
    };

    const recent = await searchService.listRecent({ type: 'user', limit: 10 });
    const texts = recent.map(r => r.text);
    expect(texts.some(t => t.includes('entry that indexes fine'))).toBe(true);
    expect(texts.some(t => t.includes('entry whose reconcile will fail'))).toBe(false);
  });
});
