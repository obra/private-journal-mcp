// ABOUTME: Path resolution utilities for journal storage locations
// ABOUTME: Provides cross-platform fallback logic for finding suitable directories

import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolves the best available directory for journal storage
 * @param subdirectory - subdirectory name (e.g., '.private-journal')
 * @param includeCurrentDirectory - whether to consider current working directory
 * @returns resolved path to journal directory
 */
export function resolveJournalPath(subdirectory: string = '.private-journal', includeCurrentDirectory: boolean = true): string {
  // PRIVATE_JOURNAL_PATH overrides all other resolution logic
  if (process.env.PRIVATE_JOURNAL_PATH) {
    return process.env.PRIVATE_JOURNAL_PATH;
  }

  const possiblePaths = [];

  // Try current working directory only if requested and it's reasonable
  if (includeCurrentDirectory) {
    try {
      const cwd = process.cwd();
      // Don't use root directories or other system directories
      if (cwd !== '/' && cwd !== 'C:\\' && cwd !== '/System' && cwd !== '/usr') {
        possiblePaths.push(path.join(cwd, subdirectory));
      }
    } catch {
      // Ignore errors getting cwd
    }
  }

  // Try home directories (cross-platform)
  if (process.env.HOME) {
    possiblePaths.push(path.join(process.env.HOME, subdirectory));
  }
  if (process.env.USERPROFILE) {
    possiblePaths.push(path.join(process.env.USERPROFILE, subdirectory));
  }

  // Try temp directories as last resort
  possiblePaths.push(path.join('/tmp', subdirectory));
  if (process.env.TEMP) {
    possiblePaths.push(path.join(process.env.TEMP, subdirectory));
  }
  if (process.env.TMP) {
    possiblePaths.push(path.join(process.env.TMP, subdirectory));
  }

  // Filter out null/undefined and return first valid path
  const validPaths = possiblePaths.filter(Boolean);
  return validPaths[0] || path.join('/tmp', subdirectory);
}

/**
 * Resolves user home directory for personal journal storage
 * @returns path to user's private journal directory
 */
export function resolveUserJournalPath(): string {
  return resolveJournalPath('.private-journal', false);
}

/**
 * Resolves project directory for project-specific journal storage
 * @returns path to project's private journal directory
 */
export function resolveProjectJournalPath(): string {
  return resolveJournalPath('.private-journal', true);
}

/**
 * Checks whether two journal paths point at the same directory, e.g. when
 * PRIVATE_JOURNAL_PATH makes the project and user journals identical
 * @param a - first journal path
 * @param b - second journal path
 * @returns true if both resolve to the same directory
 */
export function isSameJournalPath(a: string, b: string): boolean {
  // Ask the filesystem first: the same device and inode is the same directory,
  // however the paths are spelled (letter case, links, '..' segments).
  try {
    // bigint keeps 64-bit Windows file IDs exact
    const statA = fs.statSync(a, { bigint: true });
    const statB = fs.statSync(b, { bigint: true });
    // Some filesystems (FAT, some network shares) report inode 0 for everything
    if (statA.ino !== 0n && statB.ino !== 0n) {
      return statA.dev === statB.dev && statA.ino === statB.ino;
    }
  } catch {
    // A directory that doesn't exist yet has no identity to compare
  }

  const normalize = (p: string): string => {
    const resolved = path.resolve(p);
    // Windows paths are case-insensitive
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}
