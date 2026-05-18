/**
 * Unit tests for walker.ts optimizations.
 *
 * Uses lightweight Page mocks — no real Playwright browser required.
 * Tests cover:
 *   - Opt 1: Promise.race settle pattern (networkidle floor, no unhandled rejections)
 *   - Opt 2: goto skip when already on correct URL + guards (stale URL, page.url() errors)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers — minimal Page mock
// ---------------------------------------------------------------------------

type ResolveMs = number | 'never';

function makePageMock(opts: {
  urlNodeId?: string;
  networkIdleResolveMs?: ResolveMs;
  urlThrows?: boolean;
}) {
  const { urlNodeId = '5222-22288', networkIdleResolveMs = 'never', urlThrows = false } = opts;

  const mock = {
    _url: `https://www.figma.com/proto/X/?node-id=${urlNodeId}`,
    url: vi.fn(() => {
      if (urlThrows) throw new Error('Page context closed');
      return mock._url;
    }),
    goto: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async (_state: string, opts?: { timeout?: number }) => {
      const ms = networkIdleResolveMs;
      const timeout = opts?.timeout ?? 30_000;
      if (ms === 'never') {
        await new Promise((_r, reject) => setTimeout(() => reject(new Error('TimeoutError')), timeout));
      } else {
        await new Promise(r => setTimeout(r, ms));
      }
    }),
    waitForTimeout: vi.fn(async (ms: number) => {
      await new Promise(r => setTimeout(r, ms));
    }),
    mouse: { click: vi.fn(async () => {}) },
    waitForURL: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from([])),
  };
  return mock;
}

// ---------------------------------------------------------------------------
// Opt 1 — Promise.race settle pattern
// ---------------------------------------------------------------------------

describe('Opt 1 — networkidle race settle', { timeout: 10_000 }, () => {
  it('resolves within 3s ceiling even when networkidle never fires', async () => {
    const page = makePageMock({ networkIdleResolveMs: 'never' });

    const start = Date.now();
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 3_000 }).then(() => page.waitForTimeout(2_000)).catch(() => {}),
      page.waitForTimeout(3_000),
    ]);
    const elapsed = Date.now() - start;

    // Should resolve at the 3s ceiling (±200ms tolerance for test runner jitter)
    expect(elapsed).toBeGreaterThanOrEqual(2_900);
    expect(elapsed).toBeLessThan(4_000);
  });

  it('resolves in ~2s minimum when networkidle fires fast', async () => {
    // networkidle fires at 100ms, then inner waitForTimeout(2000) enforces floor
    const page = makePageMock({ networkIdleResolveMs: 100 });

    const start = Date.now();
    await Promise.race([
      page.waitForLoadState('networkidle').then(() => page.waitForTimeout(2_000)).catch(() => {}),
      page.waitForTimeout(3_000),
    ]);
    const elapsed = Date.now() - start;

    // Should be ~2.1s (100ms networkidle + 2000ms floor), not 3s ceiling
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('does not produce unhandled rejections when both legs complete', async () => {
    const page = makePageMock({ networkIdleResolveMs: 100 });
    const unhandled: Error[] = [];
    const handler = (e: Error) => unhandled.push(e);
    process.on('unhandledRejection', handler);

    await Promise.race([
      page.waitForLoadState('networkidle').then(() => page.waitForTimeout(2_000)).catch(() => {}),
      page.waitForTimeout(3_000),
    ]);

    // Give the event loop a tick to surface any unhandled rejections
    await new Promise(r => setTimeout(r, 50));
    process.off('unhandledRejection', handler);
    expect(unhandled).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Opt 2 — goto skip condition
// ---------------------------------------------------------------------------

/** Extracts the skip logic from walker.ts so it can be tested independently */
function shouldSkipGoto(pageUrl: string | (() => never), nodeIdUrl: string): boolean {
  try {
    const url = typeof pageUrl === 'function' ? pageUrl() : pageUrl;
    const currentNodeParam = new URL(url).searchParams.get('node-id');
    return currentNodeParam === nodeIdUrl;
  } catch {
    return false; // page.url() threw — force re-navigate
  }
}

describe('Opt 2 — goto skip condition', () => {
  it('skips goto when already on the correct screen', () => {
    expect(shouldSkipGoto('https://www.figma.com/proto/X/?node-id=5222-22288', '5222-22288')).toBe(true);
  });

  it('forces goto when on a different screen', () => {
    expect(shouldSkipGoto('https://www.figma.com/proto/X/?node-id=5222-22215', '5222-22288')).toBe(false);
  });

  it('handles multi-dash node IDs correctly', () => {
    // Multi-segment IDs like "89-2302" must not be confused with "89-2302-extra"
    expect(shouldSkipGoto('https://www.figma.com/proto/X/?node-id=89-2302', '89-2302')).toBe(true);
    expect(shouldSkipGoto('https://www.figma.com/proto/X/?node-id=89-2302', '89-2303')).toBe(false);
  });

  it('returns false (forces goto) when page.url() throws', () => {
    const throwFn = () => { throw new Error('Page context closed'); };
    expect(shouldSkipGoto(throwFn as never, '5222-22288')).toBe(false);
  });

  it('forces goto after a successful navigation (URL changed to destination)', () => {
    // After a successful click, page is on destination URL (different node-id)
    // Next iteration must re-navigate back to current screen
    const destNodeId = '5222-22971'; // destination node
    const currentNodeId = '5222-22288'; // current screen
    expect(shouldSkipGoto(
      `https://www.figma.com/proto/X/?node-id=${destNodeId}`,
      currentNodeId
    )).toBe(false);
  });

  it('skips goto after a failed click (URL unchanged)', () => {
    // After a failed click (no navigation), page remains on current screen
    const nodeId = '5222-22288';
    expect(shouldSkipGoto(
      `https://www.figma.com/proto/X/?node-id=${nodeId}`,
      nodeId
    )).toBe(true);
  });

  it('handles missing node-id param gracefully', () => {
    // URL without node-id param should force re-navigate
    expect(shouldSkipGoto('https://www.figma.com/proto/X/', '5222-22288')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Opt 3 — AFTER_TIMEOUT false positive guard
// ---------------------------------------------------------------------------

/** Mirrors the timeout-race guard in walker.ts */
function isTimeoutRace(actualNodeId: string, timeoutDestIds: Set<string>): boolean {
  return timeoutDestIds.has(actualNodeId);
}

describe('Opt 3 — AFTER_TIMEOUT false positive guard', () => {
  it('detects timeout race when actualNodeId matches a timeout destination', () => {
    // Skeleton AFTER_TIMEOUT → Home-first-time-biometric
    // Click on Facturas tab → expected B1, but page went to biometric (timeout fired)
    const timeoutDests = new Set(['192:2764']); // Home - first time (biometric)
    expect(isTimeoutRace('192:2764', timeoutDests)).toBe(true);
  });

  it('does not suppress genuine wrong-destination when actualNodeId is not a timeout dest', () => {
    const timeoutDests = new Set(['192:2764']);
    expect(isTimeoutRace('568:5472', timeoutDests)).toBe(false); // B1 — real wrong dest
  });

  it('returns false when screen has no AFTER_TIMEOUT reactions', () => {
    const timeoutDests = new Set<string>(); // empty — no timeouts on this screen
    expect(isTimeoutRace('568:5472', timeoutDests)).toBe(false);
  });

  it('handles multiple timeout destinations (e.g. conditional AFTER_TIMEOUT)', () => {
    const timeoutDests = new Set(['192:2764', '278:2272']); // two possible timeout dests
    expect(isTimeoutRace('192:2764', timeoutDests)).toBe(true);
    expect(isTimeoutRace('278:2272', timeoutDests)).toBe(true);
    expect(isTimeoutRace('999:9999', timeoutDests)).toBe(false);
  });
});
