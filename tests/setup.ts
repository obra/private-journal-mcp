// Global test setup
// Mock the transformers library to avoid ES module issues in Jest
jest.mock('@xenova/transformers', () => ({
  pipeline: jest.fn().mockResolvedValue((text: string) => {
    // Generate deterministic but different embeddings based on text content
    const hash = text.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const embedding = new Float32Array(5);
    for (let i = 0; i < 5; i++) {
      embedding[i] = ((hash + i) % 100) / 100; // Normalize to 0-1 range
    }
    return Promise.resolve({ data: embedding });
  }),
}));

// Mock console.error to reduce noise in test output
global.console.error = jest.fn();