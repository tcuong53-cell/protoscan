/**
 * Phase 2A — Canvas click simulator
 *
 * Walks a Figma prototype by loading it in headless Playwright, clicking
 * interactive elements at their Figma coordinates, and verifying navigation.
 *
 * Navigation strategy: load the first screen via URL, then navigate entirely
 * via clicks (like a real user). Only fall back to page.goto() when we need
 * to reach a screen not accessible from the current position.
 *
 * Coordinate mapping:
 *   canvasX = contentOffsetX + (element.x - frame.x + element.width  / 2)
 *   canvasY = contentOffsetY + (element.y - frame.y + element.height / 2)
 */

import { chromium } from 'playwright';
import { inflateSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BoundingBox, GraphEdge, Issue, PrototypeGraph } from '@protoscan/core';

export interface WalkerOptions {
  fileKey: string;
  sessionPath?: string;
  maxScreens?: number;
  navTimeout?: number;
  recordDir?: string;
}

export interface WalkResult {
  issues: Issue[];
  videoPath?: string;
}

const DEFAULT_SESSION_PATH = resolve(
  new URL(import.meta.url).pathname.replace(/\/[^/]+$/, ''),
  '../figma-session.json',
);
const PROTO_BASE = 'https://www.figma.com/proto';
const TAPPABLE_TRIGGERS = new Set(['ON_CLICK', 'ON_PRESS', 'MOUSE_DOWN']);

// Timing config
const OFFSET_MAX_RETRIES = 3;
const OFFSET_RETRY_DELAY_MS = 2_000;
const SETTLE_FLOOR_MS = 1_500;
const SETTLE_CEILING_MS = 4_000;
const STABILITY_INTERVAL_MS = 400;
const STABILITY_MAX_CHECKS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── PNG Decoder ───

function decodePngToRgba(buf: Buffer) {
  let pos = 8;
  const idatChunks: Buffer[] = [];
  let w = 0, h = 0, bpp = 4;

  while (pos < buf.length - 8) {
    const len = buf.readUInt32BE(pos); pos += 4;
    const type = buf.subarray(pos, pos + 4).toString('ascii'); pos += 4;
    const data = buf.subarray(pos, pos + len); pos += len + 4;

    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      const ct = data[9];
      if (data[8] !== 8 || (ct !== 6 && ct !== 2)) {
        throw new Error(`Unsupported PNG: bitDepth=${data[8]} colorType=${ct}`);
      }
      bpp = ct === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  const rowBytes = w * bpp;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const pixels = new Uint8Array(w * h * bpp);
  const prev = new Uint8Array(rowBytes);

  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < h; y++) {
    const srcBase = y * (rowBytes + 1);
    const filter = raw[srcBase];
    const dst = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < rowBytes; x++) {
      const byte = raw[srcBase + 1 + x];
      const L = x >= bpp ? dst[x - bpp] : 0;
      const U = prev[x];
      const UL = x >= bpp ? prev[x - bpp] : 0;
      switch (filter) {
        case 0: dst[x] = byte; break;
        case 1: dst[x] = (byte + L) & 0xff; break;
        case 2: dst[x] = (byte + U) & 0xff; break;
        case 3: dst[x] = (byte + ((L + U) >> 1)) & 0xff; break;
        case 4: dst[x] = (byte + paeth(L, U, UL)) & 0xff; break;
        default: dst[x] = byte;
      }
    }
    prev.set(dst);
  }

  return { pixels, width: w, height: h, bpp };
}

// ─── Offset Detection ───

function detectOffsetFromPixels(pixels: Uint8Array, width: number, height: number, bpp: number) {
  const brightness = (x: number, y: number) => {
    const i = (y * width + x) * bpp;
    return Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
  };

  let offsetX = 0;
  for (let x = 1; x < width - 1; x++) {
    let found = false;
    for (const yFrac of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const y = Math.floor(height * yFrac);
      const curr = brightness(x, y);
      const prev = brightness(x - 1, y);
      if (curr >= 50 || (curr - prev > 40)) { offsetX = x; found = true; break; }
    }
    if (found) break;
  }

  let offsetY = 0;
  for (let y = 1; y < height - 1; y++) {
    let found = false;
    for (const xFrac of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const x = Math.floor(width * xFrac);
      const curr = brightness(x, y);
      const prev = brightness(x, y - 1);
      if (curr >= 50 || (curr - prev > 40)) { offsetY = y; found = true; break; }
    }
    if (found) break;
  }

  return { x: offsetX, y: offsetY };
}

async function detectContentOffsetWithRetry(
  page: { screenshot: () => Promise<Buffer> },
) {
  for (let attempt = 0; attempt < OFFSET_MAX_RETRIES; attempt++) {
    const shot = await page.screenshot();
    const { pixels, width, height, bpp } = decodePngToRgba(shot);
    const offset = detectOffsetFromPixels(pixels, width, height, bpp);
    if (offset.x > 0 || offset.y > 0) return offset;
    if (attempt < OFFSET_MAX_RETRIES - 1) {
      console.log(`[walker]   ⏳ Offset (0,0) — retry ${attempt + 1}/${OFFSET_MAX_RETRIES}...`);
      await sleep(OFFSET_RETRY_DELAY_MS);
    }
  }
  console.log(`[walker]   ⚠ Could not detect offset — using (0,0)`);
  return { x: 0, y: 0 };
}

// ─── Canvas Stability ───

async function waitForCanvasStability(page: { screenshot: () => Promise<Buffer>; waitForTimeout: (ms: number) => Promise<void> }) {
  let prevHash = 0;
  for (let i = 0; i < STABILITY_MAX_CHECKS; i++) {
    const shot = await page.screenshot();
    let hash = 0;
    for (let j = 0; j < shot.length; j += 1000) hash = (hash * 31 + shot[j]) | 0;
    if (hash === prevHash && i > 0) return;
    prevHash = hash;
    if (i < STABILITY_MAX_CHECKS - 1) await page.waitForTimeout(STABILITY_INTERVAL_MS);
  }
}

async function settle(page: { waitForLoadState: (s: string) => Promise<void>; waitForTimeout: (ms: number) => Promise<void>; screenshot: () => Promise<Buffer> }) {
  await Promise.race([
    page.waitForLoadState('networkidle').then(() => page.waitForTimeout(SETTLE_FLOOR_MS)).catch(() => {}),
    page.waitForTimeout(SETTLE_CEILING_MS),
  ]);
  await waitForCanvasStability(page);
}

// Banners are handled by context.addInitScript() CSS injection — no runtime dismissal needed

// ─── Main Walker ───

export async function walkPrototype(
  graph: PrototypeGraph,
  options: WalkerOptions,
): Promise<WalkResult> {
  const {
    fileKey,
    sessionPath = DEFAULT_SESSION_PATH,
    maxScreens = 100,
    navTimeout = 8_000,
    recordDir,
  } = options;

  const hasSession = existsSync(sessionPath);

  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Executable') || msg.includes('playwright install')) {
      throw new Error('Chromium not found. Run: npx playwright install chromium');
    }
    throw err;
  }

  const context = await browser.newContext({
    viewport: { width: 800, height: 1100 },
    ...(recordDir ? { recordVideo: { dir: recordDir, size: { width: 800, height: 1100 } } } : {}),
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Hide Figma banners (cookies, hardware acceleration) via CSS injection
    // Runs before any page content loads — guaranteed to catch all banners
    const style = document.createElement('style');
    style.textContent = `
      [class*="cookie"], [class*="banner"], [class*="notification"],
      [class*="CookieBanner"], [class*="BottomBanner"], [class*="HardwareAcceleration"] {
        display: none !important;
      }
      /* Hide any fixed/sticky bottom bar under 200px tall */
      div[style*="position: fixed"][style*="bottom"],
      div[style*="position:fixed"][style*="bottom"] {
        display: none !important;
      }
    `;
    document.addEventListener('DOMContentLoaded', () => {
      document.head.appendChild(style);
      // Also try clicking dismiss buttons after a delay
      setTimeout(() => {
        document.querySelectorAll('button').forEach((btn) => {
          const t = (btn.textContent || '').toLowerCase();
          if (t.includes('allow') || t.includes('accept') || t.includes('got it') || t.includes('dismiss')) {
            btn.click();
          }
        });
        // Force-hide anything at the very bottom of the viewport
        document.querySelectorAll('div').forEach((div) => {
          const r = div.getBoundingClientRect();
          if (r.bottom > window.innerHeight - 80 && r.width > 400 && r.height < 150 && r.height > 20) {
            div.style.display = 'none';
          }
        });
      }, 2000);
    });
  });

  if (hasSession) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
      cookies: Array<{ name: string; value: string; [k: string]: unknown }>;
    };
    await context.addCookies(session.cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain as string | undefined,
      path: c.path as string | undefined, httpOnly: c.httpOnly as boolean | undefined,
      secure: true, sameSite: 'None' as const,
    })));
  }

  const page = await context.newPage();

  await page.route('**', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname.endsWith('figma.com') || url.hostname.endsWith('amazonaws.com')) {
      route.continue();
    } else {
      route.abort('blockedbyclient');
    }
  });

  const issues: Issue[] = [];
  let issueCounter = 0;
  let screensWalked = 0;

  // Map screens to their flow starting point
  const nodeToFlow = new Map<string, string>();
  for (const sp of graph.startingPoints) {
    const q = [sp.nodeId];
    const seen = new Set<string>();
    while (q.length) {
      const id = q.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!nodeToFlow.has(id)) nodeToFlow.set(id, sp.nodeId);
      for (const e of graph.edges.get(id) ?? []) q.push(e.destinationId);
    }
  }

  const flowOffsets = new Map<string, { x: number; y: number } | null>();
  const visited = new Set<string>();
  const queue: string[] = graph.startingPoints.map((sp) => sp.nodeId);
  if (queue.length === 0) {
    const first = graph.nodes.keys().next().value;
    if (first) queue.push(first);
  }

  // Track current URL node-id to avoid unnecessary page.goto() reloads
  let currentUrlNodeId = '';
  // Banners handled by addInitScript CSS injection

  /** Navigate to a screen. Returns true if we actually loaded a new URL. */
  async function navigateToScreen(nodeId: string, flowSpId: string | undefined): Promise<boolean> {
    const nodeIdUrl = nodeId.replace(':', '-');

    // If we're already on this screen (via a click that navigated here), skip goto
    if (currentUrlNodeId === nodeIdUrl) return true;

    const spParam = flowSpId ? `&starting-point-node-id=${flowSpId.replace(':', '-')}` : '';
    const url = `${PROTO_BASE}/${fileKey}/?node-id=${nodeIdUrl}&scaling=contain&hide-ui=1${spParam}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForSelector('canvas', { timeout: 15_000 });
      currentUrlNodeId = nodeIdUrl;
      return true;
    } catch {
      return false;
    }
  }

  while (queue.length > 0 && screensWalked < maxScreens) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    screensWalked++;

    const currentNode = graph.nodes.get(currentId);
    if (!currentNode?.boundingBox) continue;

    const frameBox = currentNode.boundingBox;
    const nodeIdUrl = currentId.replace(':', '-');
    const flowSpId = nodeToFlow.get(currentId) ?? graph.startingPoints[0]?.nodeId;
    const flowKey = flowSpId ?? 'default';

    console.log(`[walker] Screen ${screensWalked}: "${currentNode.name}" (${currentId})`);

    // Navigate — skip goto if we're already on this screen from a previous click
    if (currentUrlNodeId !== nodeIdUrl) {
      if (!await navigateToScreen(currentId, flowSpId)) {
        console.log(`[walker]   ⚠ Canvas not ready — skipping`);
        continue;
      }
    }

    await settle(page);


    // Collect edges
    const allNavEdges = (graph.edges.get(currentId) ?? []).filter(
      (e) => e.navigation === 'NAVIGATE' && !visited.has(e.destinationId),
    );
    for (const e of allNavEdges) {
      if (!visited.has(e.destinationId)) queue.push(e.destinationId);
    }
    const edges = allNavEdges.filter((e) => TAPPABLE_TRIGGERS.has(e.trigger));

    // Detect offset if needed
    const cachedOffset = flowOffsets.get(flowKey);
    if ((!cachedOffset || (cachedOffset.x === 0 && cachedOffset.y === 0)) && edges.length > 0) {
      const detected = await detectContentOffsetWithRetry(page);
      if (detected.x > 0 || detected.y > 0) {
        flowOffsets.set(flowKey, detected);
        console.log(`[walker]   Offset: (${detected.x}, ${detected.y})`);
      } else {
        flowOffsets.set(flowKey, null);
      }
    }

    const contentOffset = flowOffsets.get(flowKey) ?? { x: 0, y: 0 };
    const timeoutDestIds = new Set(
      (graph.edges.get(currentId) ?? [])
        .filter((e) => e.trigger === 'AFTER_TIMEOUT')
        .map((e) => e.destinationId),
    );

    // Deduplicate edges by destination
    const edgesByDest = new Map<string, GraphEdge>();
    for (const edge of edges) {
      if (!edgesByDest.has(edge.destinationId)) edgesByDest.set(edge.destinationId, edge);
    }

    for (const [destId, edge] of edgesByDest) {
      const destNode = graph.nodes.get(destId);
      if (!destNode || !edge.sourceElementBoundingBox) continue;

      const { x: ex, y: ey, width: ew, height: eh } = edge.sourceElementBoundingBox as BoundingBox;
      const frameX = ex - frameBox.x + ew / 2;
      const frameY = ey - frameBox.y + eh / 2;
      const clickX = contentOffset.x + frameX;
      const clickY = contentOffset.y + frameY;

      // Re-navigate only if a previous click took us elsewhere
      if (currentUrlNodeId !== nodeIdUrl) {
        if (!await navigateToScreen(currentId, flowSpId)) continue;
        await settle(page);
      }

      console.log(`[walker]   → click (${Math.round(clickX)}, ${Math.round(clickY)}) → "${destNode.name}"`);
      await page.mouse.click(clickX, clickY);

      // Wait for navigation
      let actualNodeId: string | null = null;
      try {
        await page.waitForURL((url) => {
          const id = url.searchParams.get('node-id');
          return !!id && id !== nodeIdUrl;
        }, { timeout: navTimeout });

        const rawId = new URL(page.url()).searchParams.get('node-id') ?? '';
        actualNodeId = rawId.replace(/^(\d+)-(\d+)$/, '$1:$2') || null;
        // Update current URL tracking so next iteration can skip goto
        if (actualNodeId) {
          currentUrlNodeId = rawId;
        }
      } catch {
        // No navigation happened
      }

      if (actualNodeId === null) {
        issues.push({
          id: `runtime-nav-failure-${++issueCounter}`,
          category: 'runtime-nav-failure',
          severity: 'high',
          confidence: 'certain',
          screenId: currentId,
          screenName: currentNode.name,
          nodeId: currentId,
          message: `Click on "${currentNode.name}" did not navigate to "${destNode.name}" — interaction appears broken at runtime.`,
          evidence: {
            expectedDestination: destId, expectedName: destNode.name,
            canvasX: Math.round(clickX), canvasY: Math.round(clickY), trigger: edge.trigger,
          },
        });
        console.log(`[walker]   ✗ No navigation (expected "${destNode.name}")`);
      } else if (actualNodeId !== destId) {
        if (timeoutDestIds.has(actualNodeId)) {
          console.log(`[walker]   ⚠ AFTER_TIMEOUT → "${graph.nodes.get(actualNodeId)?.name ?? actualNodeId}" (skipping)`);
        } else {
          issues.push({
            id: `runtime-nav-failure-${++issueCounter}`,
            category: 'runtime-nav-failure',
            severity: 'high',
            confidence: 'certain',
            screenId: currentId,
            screenName: currentNode.name,
            nodeId: currentId,
            message: `Click navigated to "${graph.nodes.get(actualNodeId)?.name ?? actualNodeId}" instead of "${destNode.name}".`,
            evidence: {
              expectedDestination: destId, expectedName: destNode.name,
              actualDestination: actualNodeId, actualName: graph.nodes.get(actualNodeId)?.name ?? actualNodeId,
              canvasX: Math.round(clickX), canvasY: Math.round(clickY),
            },
          });
          console.log(`[walker]   ✗ Wrong dest: "${graph.nodes.get(actualNodeId)?.name ?? actualNodeId}"`);
        }
        // If the click navigated us somewhere unexpected, mark it as visited
        // so the BFS doesn't waste time going back to it
        if (actualNodeId && !visited.has(actualNodeId)) {
          visited.add(actualNodeId);
        }
      } else {
        console.log(`[walker]   ✓ → "${destNode.name}"`);
        // Successful click — mark destination as visited, we're now ON this screen
        // If it's the next in the BFS queue, the outer loop will skip goto
        if (!visited.has(actualNodeId)) {
          visited.add(actualNodeId);
        }
      }
    }
  }

  let videoPath: string | undefined;
  if (recordDir) {
    videoPath = await page.video()?.path() ?? undefined;
  }

  await browser.close();

  console.log(`\n[walker] Walked ${screensWalked} screens, found ${issues.length} runtime nav failures.`);
  if (videoPath) console.log(`[walker] Recording: ${videoPath}`);
  return { issues, videoPath };
}
