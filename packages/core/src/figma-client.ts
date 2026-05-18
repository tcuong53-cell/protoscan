import type { FigmaFile } from './types.js';

const FIGMA_API_BASE = 'https://api.figma.com';

export class FigmaClient {
  private token: string;
  private lastRequestTime = 0;
  private minInterval = 3000; // ~20 req/min safe margin

  constructor(token: string) {
    this.token = token;
  }

  async getFile(fileKey: string): Promise<FigmaFile> {
    if (!/^[a-zA-Z0-9]+$/.test(fileKey)) {
      throw new FigmaApiError(400, 'Invalid file key. Figma file keys are alphanumeric.');
    }
    const data = await this.request(`/v1/files/${fileKey}`);
    return data as FigmaFile;
  }

  private async request(path: string, attempt = 0): Promise<unknown> {
    await this.throttle();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    const response = await fetch(`${FIGMA_API_BASE}${path}`, {
      headers: { 'X-Figma-Token': this.token },
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (response.status === 429 && attempt < 2) {
      const retryAfter = parseInt(response.headers.get('Retry-After') ?? '10', 10);
      const waitMs = (isNaN(retryAfter) ? 10 : retryAfter) * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.request(path, attempt + 1);
    }

    if (!response.ok) {
      const message = await this.parseError(response);
      throw new FigmaApiError(response.status, message);
    }

    return response.json();
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await new Promise((resolve) => setTimeout(resolve, this.minInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }

  private async parseError(response: Response): Promise<string> {
    const status = response.status;
    if (status === 401 || status === 403) {
      return `Figma API returned ${status} — check your token has read access to this file.`;
    }
    if (status === 404) {
      return 'File not found. Check the file key in your Figma URL.';
    }
    if (status === 429) {
      return 'Rate limited by Figma API. Try again in a few seconds.';
    }
    try {
      const body = await response.text();
      return `Figma API returned ${status}: ${body.slice(0, 200)}`;
    } catch {
      return `Figma API returned ${status}`;
    }
  }
}

export class FigmaApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'FigmaApiError';
  }
}
