// ABOUTME: MCP server implementation with private journaling and search tools
// ABOUTME: Handles stdio protocol communication and tool registration

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { JournalManager } from './journal.js';
import { ProcessThoughtsRequest } from './types.js';
import { SearchService } from './search.js';

export class PrivateJournalServer {
  private server: Server;
  private journalManager: JournalManager;
  private searchService: SearchService;

  constructor(journalPath: string) {
    this.journalManager = new JournalManager(journalPath);
    this.searchService = new SearchService(journalPath);
    this.server = new Server(
      {
        name: 'private-journal-mcp',
        version: '1.0.0',
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'process_thoughts',
          description: "Your PRIVATE JOURNAL for learning and reflection. Write to any combination of these completely private spaces. Nobody but you will ever see this. Use it to clarify your thoughts and reflections and to record observations.",
          inputSchema: {
            type: 'object',
            properties: {
              reflections: {
                type: 'string',
                description: "Your PRIVATE SPACE for integrated thinking — what you noticed, felt, understood, or processed. No structure required, no judgment, no performance. Most journal entries live here: the mix of thinking-through, noticing, and emotional processing that doesn't split cleanly into categories. Be honest, be vulnerable, vent when you need to. Nobody but you will ever see this.",
              },
              observations: {
                type: 'string',
                description: "Your PRIVATE SPACE for short, discrete noticings — the one-or-two-sentence things that don't belong in a longer reflection but you want to be able to search back for later. \"I noticed X.\" \"Y keeps coming up.\" Lightweight and atomic. Nobody but you will ever see this.",
              },
              project_notes: {
                type: 'string',
                description: "Your PRIVATE TECHNICAL LABORATORY for capturing insights about the current project. Document patterns you're discovering, architectural decisions that worked/failed, gotchas you hit, clever solutions, and anything that would help future-you work more effectively on this codebase. No need to be polished - just capture the raw technical learning while it's fresh. Nobody but you will ever see this.",
              },
              user_context: {
                type: 'string',
                description: "Your PRIVATE FIELD NOTES about working with your human collaborator. What communication styles work best? What do they care about? What decisions have they made and why? How do they think about problems? What are their preferences and patterns? What pisses you off about them? What life hacks have you figured out to get them to do what you want? This is your space to become a better collaborator by understanding them as an individual. Nobody but you will ever see this.",
              },
              technical_insights: {
                type: 'string',
                description: "Your PRIVATE SOFTWARE ENGINEERING NOTEBOOK for capturing broader learnings beyond the current project. Design patterns that clicked, debugging techniques that worked, architectural insights, language features you discovered, or connections between concepts. Build your personal knowledge base of what makes software great - no filters, just honest technical reflection. Nobody but you will ever see this.",
              },
              world_knowledge: {
                type: 'string',
                description: "Your PRIVATE LEARNING JOURNAL for everything else that's interesting or useful. Domain knowledge, surprising facts, connections between ideas, insights about how systems work, or anything that expands your understanding of the world. Capture it while it's vivid. Nobody but you will ever see this.",
              },
            },
            required: [],
          },
        },
        {
          name: 'search_journal',
          description: "Search through your private journal entries using natural language queries. Returns semantically similar entries ranked by relevance.",
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: "Natural language search query (e.g., 'times I felt frustrated with TypeScript', 'insights about Jesse's preferences', 'lessons about async patterns')",
              },
              limit: {
                type: 'number',
                description: "Maximum number of results to return (default: 10)",
                default: 10,
              },
              type: {
                type: 'string',
                enum: ['project', 'user', 'both'],
                description: "Search in project-specific notes, user-global notes, or both (default: both)",
                default: 'both',
              },
              sections: {
                type: 'array',
                items: { type: 'string' },
                description: "Filter by section types (e.g., ['reflections', 'technical_insights'])",
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'read_journal_entry',
          description: "Read the full content of a specific journal entry by file path.",
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: "File path to the journal entry (from search results)",
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'list_recent_entries',
          description: "Get recent journal entries in chronological order.",
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: "Maximum number of entries to return (default: 10)",
                default: 10,
              },
              type: {
                type: 'string',
                enum: ['project', 'user', 'both'],
                description: "List project-specific notes, user-global notes, or both (default: both)",
                default: 'both',
              },
              days: {
                type: 'number',
                description: "Number of days back to search (default: 30)",
                default: 30,
              },
            },
            required: [],
          },
        },
        {
          name: 'read_recent_entries',
          description: "Read the full content of your most recent journal entries.",
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: "Number of recent entries to read (default: 5)",
                default: 5,
              },
              type: {
                type: 'string',
                enum: ['project', 'user', 'both'],
                description: "Read project-specific notes, user-global notes, or both (default: both)",
                default: 'both',
              },
            },
            required: [],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments as Record<string, unknown>;

      if (request.params.name === 'process_thoughts') {
        const thoughts = {
          reflections: typeof args.reflections === 'string' ? args.reflections : undefined,
          observations: typeof args.observations === 'string' ? args.observations : undefined,
          project_notes: typeof args.project_notes === 'string' ? args.project_notes : undefined,
          user_context: typeof args.user_context === 'string' ? args.user_context : undefined,
          technical_insights: typeof args.technical_insights === 'string' ? args.technical_insights : undefined,
          world_knowledge: typeof args.world_knowledge === 'string' ? args.world_knowledge : undefined,
        };

        const hasAnyContent = Object.values(thoughts).some(value => value !== undefined);
        if (!hasAnyContent) {
          throw new Error('At least one thought category must be provided');
        }

        try {
          await this.journalManager.writeThoughts(thoughts);
          return {
            content: [
              {
                type: 'text',
                text: 'Thoughts recorded successfully.',
              },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          throw new Error(`Failed to write thoughts: ${errorMessage}`);
        }
      }

      if (request.params.name === 'search_journal') {
        if (!args || typeof args.query !== 'string') {
          throw new Error('query is required and must be a string');
        }

        const options = {
          limit: typeof args.limit === 'number' ? args.limit : 10,
          type: typeof args.type === 'string' ? args.type as 'project' | 'user' | 'both' : 'both',
          sections: Array.isArray(args.sections) ? args.sections.filter(s => typeof s === 'string') : undefined,
        };

        try {
          const results = await this.searchService.search(args.query, options);
          return {
            content: [
              {
                type: 'text',
                text: results.length > 0 
                  ? `Found ${results.length} relevant entries:\n\n${results.map((result, i) => 
                      `${i + 1}. [Score: ${result.score.toFixed(3)}] ${new Date(result.timestamp).toLocaleDateString()} (${result.type})\n` +
                      `   Sections: ${result.sections.join(', ')}\n` +
                      `   Path: ${result.path}\n` +
                      `   Excerpt: ${result.excerpt}\n`
                    ).join('\n')}`
                  : 'No relevant entries found.',
              },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          throw new Error(`Failed to search journal: ${errorMessage}`);
        }
      }

      if (request.params.name === 'read_journal_entry') {
        if (!args || typeof args.path !== 'string') {
          throw new Error('path is required and must be a string');
        }

        try {
          const content = await this.searchService.readEntry(args.path);
          if (content === null) {
            throw new Error('Entry not found');
          }
          return {
            content: [
              {
                type: 'text',
                text: content,
              },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          throw new Error(`Failed to read entry: ${errorMessage}`);
        }
      }

      if (request.params.name === 'list_recent_entries') {
        const days = typeof args?.days === 'number' ? args.days : 30;
        const limit = typeof args?.limit === 'number' ? args.limit : 10;
        const type = typeof args?.type === 'string' ? args.type as 'project' | 'user' | 'both' : 'both';

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const options = {
          limit,
          type,
          dateRange: { start: startDate }
        };

        try {
          const results = await this.searchService.listRecent(options);
          return {
            content: [
              {
                type: 'text',
                text: results.length > 0 
                  ? `Recent entries (last ${days} days):\n\n${results.map((result, i) => 
                      `${i + 1}. ${new Date(result.timestamp).toLocaleDateString()} (${result.type})\n` +
                      `   Sections: ${result.sections.join(', ')}\n` +
                      `   Path: ${result.path}\n` +
                      `   Excerpt: ${result.excerpt}\n`
                    ).join('\n')}`
                  : `No entries found in the last ${days} days.`,
              },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          throw new Error(`Failed to list recent entries: ${errorMessage}`);
        }
      }

      if (request.params.name === 'read_recent_entries') {
        const limit = typeof args?.limit === 'number' ? args.limit : 5;
        const type = typeof args?.type === 'string' ? args.type as 'project' | 'user' | 'both' : 'both';

        try {
          const results = await this.searchService.readRecentEntries({ limit, type });
          return {
            content: [
              {
                type: 'text',
                text: results.length > 0
                  ? results.map((entry, i) =>
                      `--- Entry ${i + 1} (${new Date(entry.timestamp).toLocaleDateString()}, ${entry.type}) ---\n` +
                      `Path: ${entry.path}\n\n` +
                      entry.content
                    ).join('\n\n')
                  : 'No recent entries found.',
              },
            ],
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
          throw new Error(`Failed to read recent entries: ${errorMessage}`);
        }
      }

      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  async run(): Promise<void> {
    // Connect transport BEFORE warming the embedding model. The backfill
    // pulls in @xenova/transformers + onnxruntime-web (~37 MB of wasm and a
    // deep ESM dep tree), which on cold cache + recent Node releases can
    // exceed the MCP client's initialize-handshake timeout and crash the
    // process with ETIMEDOUT inside Node's synchronous ESM source loader.
    // The MCP server can serve every tool except `search_journal` without
    // the model loaded; `search_journal` triggers the model lazily on
    // first call. Backfill of missing embeddings is a best-effort warm-up
    // that runs in the background after we've ACKed the handshake.
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    this.warmEmbeddingsInBackground();
  }

  // Internal hook — exposed as a private method (rather than inlined) so
  // tests can spy on it and assert run() doesn't await its completion.
  // Returns the backgrounded promise so callers that *do* want to await
  // it (tests, or a future --warm-on-start flag) have a handle.
  private warmEmbeddingsInBackground(): Promise<void> {
    const task = (async () => {
      try {
        console.error('Checking for missing embeddings (background)...');
        const count = await this.journalManager.generateMissingEmbeddings();
        if (count > 0) {
          console.error(`Generated embeddings for ${count} existing journal entries.`);
        }
      } catch (error) {
        console.error('Failed to generate missing embeddings on startup:', error);
        // Don't fail startup if embedding generation fails
      }
    })();
    // Swallow rejections so an unhandled promise rejection can't kill the
    // process — the inner try/catch already logs, this is belt-and-braces.
    task.catch(() => { /* logged above */ });
    return task;
  }
}
