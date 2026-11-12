// ABOUTME: Shared helpers for recognizing and (re)indexing journal entry files on disk.
// ABOUTME: Used by JournalManager.generateMissingEmbeddings (startup) and SearchService's
// ABOUTME: read-time backfill, so the two don't drift in what counts as an entry or how its
// ABOUTME: timestamp is recovered when the .embedding sidecar is missing.

import * as fs from 'fs/promises';
import { EmbeddingService, EmbeddingWriteResult } from './embeddings.js';

// Matches exactly the filename writeThoughtsToLocation produces (journal.ts's
// formatTimestamp): HH-MM-SS-ffffff.md. Anything else in a day directory -- a stray file, a
// .embedding, a .tmp- file left by an atomic write -- is not a journal entry and must not be
// treated as one needing an embedding.
export const JOURNAL_ENTRY_FILENAME_PATTERN = /^\d{2}-\d{2}-\d{2}-\d{6}\.md$/;

export function isJournalEntryFilename(name: string): boolean {
  return JOURNAL_ENTRY_FILENAME_PATTERN.test(name);
}

function extractTimestampFromContent(content: string): Date | null {
  const match = content.match(/^timestamp: (\d+)$/m);
  if (!match) return null;
  return new Date(parseInt(match[1], 10));
}

function extractTimestampFromFilename(filePath: string, dayDirName: string): Date | null {
  const filename = filePath.split(/[/\\]/).pop() ?? '';
  const timeMatch = filename.match(/^(\d{2})-(\d{2})-(\d{2})-\d{6}\.md$/);
  const dateMatch = dayDirName.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!timeMatch || !dateMatch) return null;

  const [, hours, minutes, seconds] = timeMatch;
  const [, year, month, day] = dateMatch;
  return new Date(
    parseInt(year, 10),
    parseInt(month, 10) - 1,
    parseInt(day, 10),
    parseInt(hours, 10),
    parseInt(minutes, 10),
    parseInt(seconds, 10)
  );
}

// Recovers an entry's timestamp when its .embedding sidecar (which would otherwise carry it)
// is missing. Prefers the YAML frontmatter's `timestamp:` field (exact, to the millisecond);
// falls back to parsing it out of the day-directory name and HH-MM-SS filename (second
// precision only); falls back to "now" if neither parses, so a malformed file still gets
// indexed rather than blocking the rest of the backfill.
export function resolveEntryTimestamp(filePath: string, dayDirName: string, content: string): Date {
  return (
    extractTimestampFromContent(content) ??
    extractTimestampFromFilename(filePath, dayDirName) ??
    new Date()
  );
}

// Reads a journal entry's .md file and attempts to (re)generate and save its .embedding
// sidecar. Shared by the startup repair (JournalManager.generateMissingEmbeddings) and the
// read-time backfill (SearchService) so both read the file and recover its timestamp the
// same way. Propagates generateAndSaveEmbedding's own internal retry; does not itself retry
// or throw on a read failure -- callers decide whether/when to try again.
export async function backfillEntryFile(
  embeddingService: EmbeddingService,
  filePath: string,
  dayDirName: string
): Promise<EmbeddingWriteResult> {
  const content = await fs.readFile(filePath, 'utf8');
  const timestamp = resolveEntryTimestamp(filePath, dayDirName, content);
  return embeddingService.generateAndSaveEmbedding(filePath, content, timestamp);
}
