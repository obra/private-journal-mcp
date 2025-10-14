// ABOUTME: Unit tests for journal writing functionality
// ABOUTME: Tests file system operations, timestamps, and formatting


import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { JournalManager } from '../src/journal.js';

function getFormattedDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

describe('JournalManager', () => {
  let projectTempDir: string;
  let userTempDir: string;
  let journalManager: JournalManager;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-project-test-'));
    userTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-user-test-'));
    
    // Mock HOME environment
    originalHome = process.env.HOME;
    process.env.HOME = userTempDir;
    
    journalManager = new JournalManager(projectTempDir);
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

  test('writes journal entry to correct file structure', async () => {
    const content = 'This is a test journal entry.';
    
    await journalManager.writeEntry(content);

    const today = new Date();
    const dateString = getFormattedDate(today);
    const dayDir = path.join(projectTempDir, dateString);
    
    const files = await fs.readdir(dayDir);
    expect(files).toHaveLength(2); // .md and .embedding files
    
    const mdFile = files.find(f => f.endsWith('.md'));
    const embeddingFile = files.find(f => f.endsWith('.embedding'));
    
    expect(mdFile).toBeDefined();
    expect(embeddingFile).toBeDefined();
    expect(mdFile).toMatch(/^\d{2}-\d{2}-\d{2}-\d{6}\.md$/);
  });

  test('creates directory structure automatically', async () => {
    const content = 'Test entry';
    
    await journalManager.writeEntry(content);

    const today = new Date();
    const dateString = getFormattedDate(today);
    const dayDir = path.join(projectTempDir, dateString);
    
    const stats = await fs.stat(dayDir);
    expect(stats.isDirectory()).toBe(true);
  });

  test('formats entry content correctly', async () => {
    const content = 'This is my journal entry content.';
    
    await journalManager.writeEntry(content);

    const today = new Date();
    const dateString = getFormattedDate(today);
    const dayDir = path.join(projectTempDir, dateString);
    const files = await fs.readdir(dayDir);
    const mdFile = files.find(f => f.endsWith('.md'));
    const filePath = path.join(dayDir, mdFile!);
    
    const fileContent = await fs.readFile(filePath, 'utf8');
    
    expect(fileContent).toContain('---');
    expect(fileContent).toContain('title: "');
    expect(fileContent).toContain('date: ');
    expect(fileContent).toContain('timestamp: ');
    expect(fileContent).toContain(' - ');
    expect(fileContent).toContain(content);
    
    // Check YAML frontmatter structure
    const lines = fileContent.split('\n');
    expect(lines[0]).toBe('---');
    expect(lines[1]).toMatch(/^title: ".*"$/);
    expect(lines[2]).toMatch(/^date: \d{4}-\d{2}-\d{2}T/);
    expect(lines[3]).toMatch(/^timestamp: \d+$/);
    expect(lines[4]).toBe('---');
    expect(lines[5]).toBe('');
    expect(lines[6]).toBe(content);
  });

  test('handles multiple entries on same day', async () => {
    await journalManager.writeEntry('First entry');
    await journalManager.writeEntry('Second entry');

    const today = new Date();
    const dateString = getFormattedDate(today);
    const dayDir = path.join(projectTempDir, dateString);
    const files = await fs.readdir(dayDir);
    
    expect(files).toHaveLength(4); // 2 .md files + 2 .embedding files
    const mdFiles = files.filter(f => f.endsWith('.md'));
    expect(mdFiles).toHaveLength(2);
    expect(mdFiles[0]).not.toEqual(mdFiles[1]);
  });

  test('handles empty content', async () => {
    const content = '';
    
    await journalManager.writeEntry(content);

    const today = new Date();
    const dateString = getFormattedDate(today);
    const dayDir = path.join(projectTempDir, dateString);
    const files = await fs.readdir(dayDir);
    
    expect(files).toHaveLength(1); // Only .md file, no .embedding file for empty content
    
    const mdFile = files.find(f => f.endsWith('.md'));
    expect(mdFile).toBeDefined();
    
    const filePath = path.join(dayDir, mdFile!);
    const fileContent = await fs.readFile(filePath, 'utf8');
    
    expect(fileContent).toContain('---');
    expect(fileContent).toContain('title: "');
    expect(fileContent).toContain(' - ');
    expect(fileContent).toMatch(/date: \d{4}-\d{2}-\d{2}T/);
    expect(fileContent).toMatch(/timestamp: \d+/);
  });

  test('handles large content', async () => {
    const content = 'A'.repeat(10000);
    
    await journalManager.writeEntry(content);

    const today = new Date();
    const dateString = getFormattedDate(today);
    const dayDir = path.join(projectTempDir, dateString);
    const files = await fs.readdir(dayDir);
    
    const mdFile = files.find(f => f.endsWith('.md'));
    expect(mdFile).toBeDefined();
    
    const filePath = path.join(dayDir, mdFile!);
    const fileContent = await fs.readFile(filePath, 'utf8');
    expect(fileContent).toContain(content);
  });

  test('writes project notes to project directory', async () => {
    const thoughts = {
      project_notes: 'The architecture is solid'
    };
    
    await journalManager.writeThoughts(thoughts);

    const today = new Date();
    const dateString = getFormattedDate(today);
    const projectDayDir = path.join(projectTempDir, dateString);
    
    const projectFiles = await fs.readdir(projectDayDir);
    expect(projectFiles).toHaveLength(2); // .md and .embedding files
    
    const mdFile = projectFiles.find(f => f.endsWith('.md'));
    expect(mdFile).toBeDefined();
    
    const projectFilePath = path.join(projectDayDir, mdFile!);
    const projectContent = await fs.readFile(projectFilePath, 'utf8');
    
    expect(projectContent).toContain('## Project Notes');
    expect(projectContent).toContain('The architecture is solid');
    expect(projectContent).not.toContain('## Feelings');
  });

  test('writes user thoughts to user directory', async () => {
    const thoughts = {
      feelings: 'I feel great about this feature',
      technical_insights: 'TypeScript interfaces are powerful'
    };
    
    await journalManager.writeThoughts(thoughts);

    const today = new Date();
    const dateString = getFormattedDate(today);
    const userDayDir = path.join(userTempDir, '.private-journal', dateString);
    
    const userFiles = await fs.readdir(userDayDir);
    expect(userFiles).toHaveLength(2); // .md and .embedding files
    
    const mdFile = userFiles.find(f => f.endsWith('.md'));
    expect(mdFile).toBeDefined();
    
    const userFilePath = path.join(userDayDir, mdFile!);
    const userContent = await fs.readFile(userFilePath, 'utf8');
    
    expect(userContent).toContain('## Feelings');
    expect(userContent).toContain('I feel great about this feature');
    expect(userContent).toContain('## Technical Insights');
    expect(userContent).toContain('TypeScript interfaces are powerful');
    expect(userContent).not.toContain('## Project Notes');
  });

  test('splits thoughts between project and user directories', async () => {
    const thoughts = {
      feelings: 'I feel great',
      project_notes: 'The architecture is solid',
      user_context: 'Jesse prefers simple solutions',
      technical_insights: 'TypeScript is powerful',
      world_knowledge: 'Git workflows matter'
    };
    
    await journalManager.writeThoughts(thoughts);

    const today = new Date();
    const dateString = getFormattedDate(today);
    
    // Check project directory
    const projectDayDir = path.join(projectTempDir, dateString);
    const projectFiles = await fs.readdir(projectDayDir);
    expect(projectFiles).toHaveLength(2); // .md and .embedding files
    
    const projectMdFile = projectFiles.find(f => f.endsWith('.md'));
    expect(projectMdFile).toBeDefined();
    
    const projectContent = await fs.readFile(path.join(projectDayDir, projectMdFile!), 'utf8');
    expect(projectContent).toContain('## Project Notes');
    expect(projectContent).toContain('The architecture is solid');
    expect(projectContent).not.toContain('## Feelings');
    
    // Check user directory
    const userDayDir = path.join(userTempDir, '.private-journal', dateString);
    const userFiles = await fs.readdir(userDayDir);
    expect(userFiles).toHaveLength(2); // .md and .embedding files
    
    const userMdFile = userFiles.find(f => f.endsWith('.md'));
    expect(userMdFile).toBeDefined();
    
    const userContent = await fs.readFile(path.join(userDayDir, userMdFile!), 'utf8');
    expect(userContent).toContain('## Feelings');
    expect(userContent).toContain('## User Context');
    expect(userContent).toContain('## Technical Insights');
    expect(userContent).toContain('## World Knowledge');
    expect(userContent).not.toContain('## Project Notes');
  });

  test('handles thoughts with only user sections', async () => {
    const thoughts = {
      world_knowledge: 'Learned something interesting about databases'
    };
    
    await journalManager.writeThoughts(thoughts);

    const today = new Date();
    const dateString = getFormattedDate(today);
    
    // Should only create user directory, not project directory
    const userDayDir = path.join(userTempDir, '.private-journal', dateString);
    const userFiles = await fs.readdir(userDayDir);
    expect(userFiles).toHaveLength(2); // .md and .embedding files
    
    const userMdFile = userFiles.find(f => f.endsWith('.md'));
    expect(userMdFile).toBeDefined();
    
    const userContent = await fs.readFile(path.join(userDayDir, userMdFile!), 'utf8');
    expect(userContent).toContain('## World Knowledge');
    expect(userContent).toContain('Learned something interesting about databases');
    
    // Project directory should not exist
    const projectDayDir = path.join(projectTempDir, dateString);
    await expect(fs.access(projectDayDir)).rejects.toThrow();
  });

  test('handles thoughts with only project sections', async () => {
    const thoughts = {
      project_notes: 'This specific codebase pattern works well'
    };
    
    await journalManager.writeThoughts(thoughts);

    const today = new Date();
    const dateString = getFormattedDate(today);
    
    // Should only create project directory, not user directory
    const projectDayDir = path.join(projectTempDir, dateString);
    const projectFiles = await fs.readdir(projectDayDir);
    expect(projectFiles).toHaveLength(2); // .md and .embedding files
    
    const projectMdFile = projectFiles.find(f => f.endsWith('.md'));
    expect(projectMdFile).toBeDefined();
    
    const projectContent = await fs.readFile(path.join(projectDayDir, projectMdFile!), 'utf8');
    expect(projectContent).toContain('## Project Notes');
    expect(projectContent).toContain('This specific codebase pattern works well');
    
    // User directory should not exist
    const userDayDir = path.join(userTempDir, '.private-journal', dateString);
    await expect(fs.access(userDayDir)).rejects.toThrow();
  });

  test('uses explicit user journal path when provided', async () => {
    const customUserDir = await fs.mkdtemp(path.join(os.tmpdir(), 'custom-user-'));
    const customJournalManager = new JournalManager(projectTempDir, customUserDir);
    
    try {
      const thoughts = { feelings: 'Testing custom path' };
      await customJournalManager.writeThoughts(thoughts);

      const today = new Date();
      const dateString = getFormattedDate(today);
      const customDayDir = path.join(customUserDir, dateString);
      
      const customFiles = await fs.readdir(customDayDir);
      expect(customFiles).toHaveLength(2); // .md and .embedding files
      
      const customMdFile = customFiles.find(f => f.endsWith('.md'));
      expect(customMdFile).toBeDefined();
      
      const customContent = await fs.readFile(path.join(customDayDir, customMdFile!), 'utf8');
      expect(customContent).toContain('Testing custom path');
    } finally {
      await fs.rm(customUserDir, { recursive: true, force: true });
    }
  });
});