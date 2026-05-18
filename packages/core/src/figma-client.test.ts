import { describe, it, expect } from 'vitest';
import { FigmaClient, FigmaApiError } from './figma-client.js';

describe('FigmaClient', () => {
  it('rejects file keys with path traversal characters', async () => {
    const client = new FigmaClient('fake-token');
    await expect(client.getFile('../v2/me')).rejects.toThrow(FigmaApiError);
    await expect(client.getFile('../v2/me')).rejects.toThrow('Invalid file key');
  });

  it('rejects file keys with slashes', async () => {
    const client = new FigmaClient('fake-token');
    await expect(client.getFile('abc/def')).rejects.toThrow('Invalid file key');
  });

  it('rejects file keys with query params', async () => {
    const client = new FigmaClient('fake-token');
    await expect(client.getFile('abc?foo=bar')).rejects.toThrow('Invalid file key');
  });

  it('accepts valid alphanumeric file keys', async () => {
    const client = new FigmaClient('fake-token');
    // This will fail with a network error (not validation error) — that's expected
    try {
      await client.getFile('abc123XYZ');
    } catch (e) {
      // Should NOT be a validation error
      expect((e as Error).message).not.toContain('Invalid file key');
    }
  });
});
