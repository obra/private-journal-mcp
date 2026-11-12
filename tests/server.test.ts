// ABOUTME: Tests for PrivateJournalServer startup behavior
// ABOUTME: Asserts MCP transport handshake is not gated on embedding warm-up.

// The MCP SDK is heavy and we only care about call ordering here, so stub
// the transport + Server.connect surface before importing the SUT.
const connectMock = jest.fn().mockResolvedValue(undefined);
const setRequestHandlerMock = jest.fn();

jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn().mockImplementation(() => ({
    connect: connectMock,
    setRequestHandler: setRequestHandlerMock,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: { __schema: 'call' },
  ListToolsRequestSchema: { __schema: 'list' },
}));

import { PrivateJournalServer } from '../src/server';
import { JournalManager } from '../src/journal';

describe('PrivateJournalServer.run()', () => {
  beforeEach(() => {
    connectMock.mockClear();
    setRequestHandlerMock.mockClear();
  });

  test('returns before generateMissingEmbeddings resolves (handshake is not gated on ML warm-up)', async () => {
    let releaseEmbedding: () => void = () => {};
    const embeddingPromise = new Promise<number>((resolve) => {
      releaseEmbedding = () => resolve(0);
    });

    const generateSpy = jest
      .spyOn(JournalManager.prototype, 'generateMissingEmbeddings')
      .mockReturnValue(embeddingPromise);

    const server = new PrivateJournalServer('/tmp/private-journal-test');

    // run() must resolve even though generateMissingEmbeddings() is still
    // pending — that's the whole point of the fix. If run() awaits the
    // backfill the test will hang until releaseEmbedding() is called and
    // jest's testTimeout (60s) will fail it.
    const runResult = server.run();
    await expect(runResult).resolves.toBeUndefined();

    // Transport should have been connected during run()
    expect(connectMock).toHaveBeenCalledTimes(1);

    // The backfill should have been kicked off (synchronously enough to
    // be observable on the next microtask after run() resolved).
    await Promise.resolve();
    expect(generateSpy).toHaveBeenCalledTimes(1);

    // Cleanly release the still-pending backfill so jest doesn't warn
    // about open handles.
    releaseEmbedding();
    await embeddingPromise;
    generateSpy.mockRestore();
  });

  test('a thrown rejection from generateMissingEmbeddings does not crash the server', async () => {
    const generateSpy = jest
      .spyOn(JournalManager.prototype, 'generateMissingEmbeddings')
      .mockRejectedValue(new Error('simulated ETIMEDOUT'));

    // Quiet the expected console.error so the test output stays clean.
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const server = new PrivateJournalServer('/tmp/private-journal-test');
    await expect(server.run()).resolves.toBeUndefined();

    // Let the background task settle.
    await new Promise((r) => setImmediate(r));

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledTimes(1);
    // We logged the failure rather than propagating it.
    expect(
      errSpy.mock.calls.some((call) =>
        String(call[0]).includes('Failed to generate missing embeddings on startup')
      )
    ).toBe(true);

    generateSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('connect() is called before generateMissingEmbeddings() (transport-first ordering)', async () => {
    const callOrder: string[] = [];

    connectMock.mockImplementationOnce(async () => {
      callOrder.push('connect');
    });

    const generateSpy = jest
      .spyOn(JournalManager.prototype, 'generateMissingEmbeddings')
      .mockImplementation(async () => {
        callOrder.push('generate');
        return 0;
      });

    const server = new PrivateJournalServer('/tmp/private-journal-test');
    await server.run();
    // Wait for the background task to land its mark.
    await new Promise((r) => setImmediate(r));

    expect(callOrder[0]).toBe('connect');
    expect(callOrder).toContain('generate');
    expect(callOrder.indexOf('connect')).toBeLessThan(callOrder.indexOf('generate'));

    generateSpy.mockRestore();
  });
});
