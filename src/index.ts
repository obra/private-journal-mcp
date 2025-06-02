#!/usr/bin/env node

// ABOUTME: Main entry point for the private journal MCP server
// ABOUTME: Handles command line arguments and starts the server

import * as path from 'path';
import { PrivateJournalServer } from './server.js';
import { resolveProjectJournalPath } from './paths.js';

function parseArguments(): string {
  const args = process.argv.slice(2);
  
  // Check for explicit journal path argument first
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--journal-path' && i + 1 < args.length) {
      return path.resolve(args[i + 1]);
    }
  }
  
  // Use shared path resolution logic
  return resolveProjectJournalPath();
}

async function main(): Promise<void> {
  try {
    // Log environment info for debugging
    console.error('=== Private Journal MCP Server Debug Info ===');
    console.error(`Node.js version: ${process.version}`);
    console.error(`Platform: ${process.platform}`);
    console.error(`Architecture: ${process.arch}`);
    
    try {
      console.error(`Current working directory: ${process.cwd()}`);
    } catch (error) {
      console.error(`Failed to get current working directory: ${error}`);
    }
    
    console.error(`Environment variables:`);
    console.error(`  HOME: ${process.env.HOME || 'undefined'}`);
    console.error(`  USERPROFILE: ${process.env.USERPROFILE || 'undefined'}`);
    console.error(`  TEMP: ${process.env.TEMP || 'undefined'}`);
    console.error(`  TMP: ${process.env.TMP || 'undefined'}`);
    console.error(`  USER: ${process.env.USER || 'undefined'}`);
    console.error(`  USERNAME: ${process.env.USERNAME || 'undefined'}`);
    
    const journalPath = parseArguments();
    console.error(`Selected journal path: ${journalPath}`);
    console.error('===============================================');
    
    const server = new PrivateJournalServer(journalPath);
    await server.run();
  } catch (error) {
    console.error('Failed to start private journal MCP server:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});