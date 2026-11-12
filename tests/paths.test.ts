// ABOUTME: Unit tests for path resolution utilities
// ABOUTME: Tests cross-platform fallback logic and environment handling

import * as path from 'path';
import { resolveJournalPath, resolveUserJournalPath, resolveProjectJournalPath } from '../src/paths';

describe('Path resolution utilities', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('resolveJournalPath uses current directory when reasonable', () => {
    // Mock a reasonable current working directory
    const mockCwd = '/Users/test/projects/my-app';
    jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
    
    const result = resolveJournalPath('.private-journal', true);
    expect(result).toBe(path.join(mockCwd, '.private-journal'));
  });

  test('resolveJournalPath skips system directories', () => {
    const systemPaths = ['/', 'C:\\', '/System', '/usr'];
    
    systemPaths.forEach(systemPath => {
      jest.spyOn(process, 'cwd').mockReturnValue(systemPath);
      process.env.HOME = '/Users/test';
      
      const result = resolveJournalPath('.private-journal', true);
      expect(result).toBe(path.join('/Users/test', '.private-journal'));
    });
  });

  test('resolveJournalPath falls back to HOME when current directory excluded', () => {
    process.env.HOME = '/Users/test';
    delete process.env.USERPROFILE;
    
    const result = resolveJournalPath('.private-journal', false);
    expect(result).toBe(path.join('/Users/test', '.private-journal'));
  });

  test('resolveJournalPath uses USERPROFILE on Windows', () => {
    delete process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\test';
    
    const result = resolveJournalPath('.private-journal', false);
    expect(result).toBe(path.join('C:\\Users\\test', '.private-journal'));
  });

  test('resolveJournalPath falls back to temp directory', () => {
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    delete process.env.TEMP;
    delete process.env.TMP;
    
    const result = resolveJournalPath('.private-journal', false);
    expect(result).toBe(path.join('/tmp', '.private-journal'));
  });

  test('resolveUserJournalPath excludes current directory', () => {
    const mockCwd = '/Users/test/projects/my-app';
    jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
    process.env.HOME = '/Users/test';
    
    const result = resolveUserJournalPath();
    expect(result).toBe(path.join('/Users/test', '.private-journal'));
    expect(result).not.toContain('projects/my-app');
  });

  test('resolveProjectJournalPath includes current directory', () => {
    const mockCwd = '/Users/test/projects/my-app';
    jest.spyOn(process, 'cwd').mockReturnValue(mockCwd);
    
    const result = resolveProjectJournalPath();
    expect(result).toBe(path.join(mockCwd, '.private-journal'));
  });

  test('both user and project paths are consistent when no project context', () => {
    // Simulate no reasonable project directory
    jest.spyOn(process, 'cwd').mockReturnValue('/');
    process.env.HOME = '/Users/test';

    const userPath = resolveUserJournalPath();
    const projectPath = resolveProjectJournalPath();

    expect(userPath).toBe(path.join('/Users/test', '.private-journal'));
    expect(projectPath).toBe(path.join('/Users/test', '.private-journal'));
  });

  describe('PRIVATE_JOURNAL_PATH override', () => {
    test('resolveJournalPath uses PRIVATE_JOURNAL_PATH when set', () => {
      process.env.PRIVATE_JOURNAL_PATH = '/data/journals';
      process.env.HOME = '/Users/test';
      jest.spyOn(process, 'cwd').mockReturnValue('/Users/test/projects/my-app');

      const result = resolveJournalPath('.private-journal', true);
      expect(result).toBe('/data/journals');
    });

    test('resolveUserJournalPath uses PRIVATE_JOURNAL_PATH when set', () => {
      process.env.PRIVATE_JOURNAL_PATH = '/data/journals';
      process.env.HOME = '/Users/test';

      const result = resolveUserJournalPath();
      expect(result).toBe('/data/journals');
    });

    test('resolveProjectJournalPath uses PRIVATE_JOURNAL_PATH when set', () => {
      process.env.PRIVATE_JOURNAL_PATH = '/data/journals';
      jest.spyOn(process, 'cwd').mockReturnValue('/Users/test/projects/my-app');

      const result = resolveProjectJournalPath();
      expect(result).toBe('/data/journals');
    });

    test('PRIVATE_JOURNAL_PATH makes user and project paths identical', () => {
      process.env.PRIVATE_JOURNAL_PATH = '/container/journal-data';
      process.env.HOME = '/Users/test';
      jest.spyOn(process, 'cwd').mockReturnValue('/Users/test/projects/my-app');

      const userPath = resolveUserJournalPath();
      const projectPath = resolveProjectJournalPath();

      expect(userPath).toBe('/container/journal-data');
      expect(projectPath).toBe('/container/journal-data');
    });

    test('PRIVATE_JOURNAL_PATH ignores subdirectory parameter', () => {
      process.env.PRIVATE_JOURNAL_PATH = '/data/journals';

      const result = resolveJournalPath('.some-other-name', true);
      expect(result).toBe('/data/journals');
    });
  });
});