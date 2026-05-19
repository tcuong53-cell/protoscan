/**
 * Phase 2A — Canvas click simulator
 *
 * BFS-walks a Figma prototype by loading each screen in headless Playwright,
 * clicking interactive elements at their Figma coordinates, and verifying the
 * URL updates to the expected destination node.
 *
 * Coordinate mapping:
 *   The prototype renders inside a device mockup (phone frame) which offsets
 *   the actual screen content within the browser canvas. We detect this offset
 *   via screenshot analysis, then apply it to all clicks:
 *     canvasX = contentOffsetX + (element.x - frame.x + element.width  / 2)
 *     canvasY = contentOffsetY + (element.y - frame.y + element.height / 2)
 *
 * Viewport is set to 800×1100 (larger than any phone mockup) so the device
 * frame renders at native scale=1, centered, and never clips content.
 */

import { chromium } from 'playwright';
import { inflateSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BoundingBox, GraphEdge, Issue, PrototypeGraph } from '@protoscan/core';

export interface WalkerOptions {
  fileKey: string;
  /** Path to a Playwright storageState JSON (captured via poc.ts --capture) */
  sessionPath?: string;
  /** Max screens to walk (safety limit) */
  maxScreens?: number;
  /** Timeout per navigation click in ms */
  navTimeout?: number;
  /** Directory to save walkthrough recording video. Enables Playwright recordVideo. */
  recordDir?: string;
}

export interface WalkResult {
  issues: Issue[];
  /** Path to the recorded .webm video, if --record was enabled */
  videoPath?: string;
}

const DEFAULT_SESSION_PATH = resolve(
  new URL(import.meta.url).pathname.replace(/\/[^/]+$/, ''),
  '../figma-session.json',
);
const PROTO_BASE = 'https://www.figma.com/proto';

/** Triggers that map to a single tap/click gesture */
const TAPPABLE_TRIGGERS = new Set(['ON_CLICK', 'ON_PRESS', 'MOUSE_DOWN']);

// Offset detection config
const OFFSET_MAX_RETRIES = 3;
const OFFSET_RETRY_DELAY_MS = 2_000;

// Settle config
const SETTLE_FLOOR_MS = 2_000;
const SETTLE_CEILING_MS = 5_000; // increased from 3s to 5s
const STABILITY_CHECK_INTERVAL_MS = 600;
const STABILITY_CHECK_MAX_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Decode a PNG screenshot into raw RGBA pixel data.
 * Validates IHDR: bit depth must be 8, color type must be 6 (RGBA).
 */
function decodePngToRgba(
  screenshotBuf: Buffer,
): { pixels: Uint8Array; width: number; height: number } {
  let pos = 8; // skip PNG signature
  const idatChunks: Buffer[] = [];
  let imgWidth = 0;
  let imgHeight = 0;
  let bytesPerPixel = 4; // default RGBA, updated from IHDR

  while (pos < screenshotBuf.length - 8) {
    const len = screenshotBuf.readUInt32BE(pos); pos += 4;
    const type = screenshotBuf.subarray(pos, pos + 4).toString('ascii'); pos += 4;
    const data = screenshotBuf.subarray(pos, pos + len); pos += len + 4; // skip CRC

    if (type === 'IHDR') {
      imgWidth  = data.readUInt32BE(0);
      imgHeight = data.readUInt32BE(4);
      // Fix 5: Validate color format — accept RGB (2) and RGBA (6)
      const bitDepth = data[8];
      const colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
        throw new Error(`Unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType} (expected 8-bit RGB or RGBA)`);
      }
      bytesPerPixel = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  const rowBytes = imgWidth * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const pixels = new Uint8Array(imgWidth * imgHeight * bytesPerPixel);
  const prev = new Uint8Array(rowBytes);

  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < imgHeight; y++) {
    const srcBase = y * (rowBytes + 1);
    const filter = raw[srcBase];
    const dst = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);

    for (let x = 0; x < rowBytes; x++) {
      const byte = raw[srcBase + 1 + x];
      const L = x >= bytesPerPixel ? dst[x - bytesPerPixel] : 0;
      const U = prev[x];
      const UL = x >= bytesPerPixel ? prev[x - bytesPerPixel] : 0;
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

  return { pixels, width: imgWidth, height: imgHeight, bytesPerPixel };
}

/**
 * Detect the pixel offset of the prototype screen content within the browser
 * viewport by analysing decoded RGBA pixels.
 *
 * Scans inward from edges to find where non-background content begins.
 * Uses brightness threshold AND edge transition detection for robustness.
 */
function detectOffsetFromPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  bpp: number = 4,
): { x: number; y: number } {
  const brightness = (x: number, y: number): number => {
    const i = (y * width + x) * bpp;
    return Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
  };

  // Strategy: scan from edge inward, looking for a brightness jump > 60
  // This handles dark-themed UIs where content pixels are still < 50 but brighter
  // than the pure-black (0-5) Figma viewer background.

  // Scan from left
  let offsetX = 0;
  for (let x = 1; x < width - 1; x++) {
    let found = false;
    for (const yFrac of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const y = Math.floor(height * yFrac);
      const curr = brightness(x, y);
      const prev = brightness(x - 1, y);
      // Either absolute brightness or a sharp edge transition
      if (curr >= 50 || (curr - prev > 40)) {
        offsetX = x;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  // Scan from top
  let offsetY = 0;
  for (let y = 1; y < height - 1; y++) {
    let found = false;
    for (const xFrac of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const x = Math.floor(width * xFrac);
      const curr = brightness(x, y);
      const prev = brightness(x, y - 1);
      if (curr >= 50 || (curr - prev > 40)) {
        offsetY = y;
        found = true;
        break;
      }
    }
    if (found) break;
  }

  return { x: offsetX, y: offsetY };
}

/**
 * Take a screenshot and detect content offset.
 * Retries with delay if offset is (0,0) — likely means canvas hasn't painted yet.
 */
async function detectContentOffsetWithRetry(
  page: { screenshot: () => Promise<Buffer> },
): Promise<{ x: number; y: number }> {
  for (let attempt = 0; attempt < OFFSET_MAX_RETRIES; attempt++) {
    const shot = await page.screenshot();
    const { pixels, width, height, bytesPerPixel } = decodePngToRgba(shot);
    const offset = detectOffsetFromPixels(pixels, width, height, bytesPerPixel);

    // Fix 2: (0,0) on 800x1100 viewport is almost certainly wrong — retry
    if (offset.x > 0 || offset.y > 0) {
      return offset;
    }

    if (attempt < OFFSET_MAX_RETRIES - 1) {
      console.log(`[walker]   ⏳ Offset (0,0) — canvas may not be painted, retry ${attempt + 1}/${OFFSET_MAX_RETRIES}...`);
      await sleep(OFFSET_RETRY_DELAY_MS);
    }
  }

  // Last resort: return (0,0) but log a warning
  console.log(`[walker]   ⚠ Could not detect content offset after ${OFFSET_MAX_RETRIES} attempts — using (0,0)`);
  return { x: 0, y: 0 };
}

/**
 * Wait for canvas to stabilize by comparing two screenshots.
 * Returns when consecutive screenshots are identical (canvas stopped painting).
 */
async function waitForCanvasStability(
  page: { screenshot: () => Promise<Buffer>; waitForTimeout: (ms: number) => Promise<void> },
): Promise<void> {
  let prevHash = '';
  for (let i = 0; i < STABILITY_CHECK_MAX_ATTEMPTS; i++) {
    const shot = await page.screenshot();
    // Simple hash: sum of every 1000th pixel value
    let hash = 0;
    for (let j = 0; j < shot.length; j += 1000) {
      hash = (hash * 31 + shot[j]) | 0;
    }
    const hashStr = String(hash);
    if (hashStr === prevHash && prevHash !== '') {
      return; // Canvas is stable
    }
    prevHash = hashStr;
    if (i < STABILITY_CHECK_MAX_ATTEMPTS - 1) {
      await page.waitForTimeout(STABILITY_CHECK_INTERVAL_MS);
    }
  }
}

/**
 * Combined settle: wait for network + stability check.
 */
async function settleAndStabilize(
  page: { waitForLoadState: (s: string) => Promise<void>; waitForTimeout: (ms: number) => Promise<void>; screenshot: () => Promise<Buffer> },
): Promise<void> {
  // Phase 1: network settle with ceiling
  await Promise.race([
    page.waitForLoadState('networkidle').then(() => page.waitForTimeout(SETTLE_FLOOR_MS)).catch(() => {}),
    page.waitForTimeout(SETTLE_CEILING_MS),
  ]);
  // Phase 2: screenshot stability check
  await waitForCanvasStability(page);
}

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
      throw new Error(
        'Chromium browser not found. Run: npx playwright install chromium\n' +
        'Or reinstall the package: npm install @protoscan/simulator',
      );
    }
    throw err;
  }

  // Large viewport so the phone mockup renders at native scale and never clips
  const context = await browser.newContext({
    viewport: { width: 800, height: 1100 },
    ...(recordDir ? { recordVideo: { dir: recordDir, size: { width: 800, height: 1100 } } } : {}),
  });

  // Prevent automation detection — Figma disables ON_CLICK when navigator.webdriver is set
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  if (hasSession) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
      cookies: Array<{ name: string; value: string; [k: string]: unknown }>;
    };
    const cookies = session.cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain as string | undefined,
      path: c.path as string | undefined, httpOnly: c.httpOnly as boolean | undefined,
      secure: true, sameSite: 'None' as const,
    }));
    await context.addCookies(cookies);
  }

  const page = await context.newPage();

  // Block navigation outside figma.com to prevent OPEN_URL prototype actions
  // from reaching attacker-controlled URLs during the walk.
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

  // Map each screen to the flow starting point that can reach it
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

  // Detected content offset per flow (keyed by starting point nodeId)
  // Fix 2: null means "not yet detected" — we re-attempt on each screen until valid
  const flowOffsets = new Map<string, { x: number; y: number } | null>();

  // BFS from all flow starting points
  const visited = new Set<string>();
  const queue: string[] = graph.startingPoints.map((sp) => sp.nodeId);
  if (queue.length === 0) {
    const first = graph.nodes.keys().next().value;
    if (first) queue.push(first);
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
    console.log(`[walker] Screen ${screensWalked}: "${currentNode.name}" (${currentId}) flow="${flowSpId}"`);
    const spParam = flowSpId ? `&starting-point-node-id=${flowSpId.replace(':', '-')}` : '';
    // Fix 4: scaling=contain instead of min-zoom for reliable 1:1 pixel mapping
    const protoUrl = `${PROTO_BASE}/${fileKey}/?node-id=${nodeIdUrl}&scaling=contain&hide-ui=1${spParam}`;
    try {
      await page.goto(protoUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForSelector('canvas', { timeout: 15_000 });
    } catch {
      console.log(`[walker]   ⚠ Canvas not ready for "${currentNode.name}" — skipping`);
      continue;
    }

    // Settle + canvas stability check
    await settleAndStabilize(page);

    // All outgoing NAVIGATE edges (to queue non-tappable destinations too)
    const allNavEdges = (graph.edges.get(currentId) ?? []).filter(
      (e) => e.navigation === 'NAVIGATE' && !visited.has(e.destinationId),
    );
    // Queue ALL navigate destinations for graph coverage
    for (const e of allNavEdges) {
      if (!visited.has(e.destinationId)) queue.push(e.destinationId);
    }
    // Only CLICK tappable triggers
    const edges = allNavEdges.filter((e) => TAPPABLE_TRIGGERS.has(e.trigger));

    // Detect content offset — retry if (0,0), re-detect if not yet cached
    const flowKey = flowSpId ?? 'default';
    const cachedOffset = flowOffsets.get(flowKey);
    if ((!cachedOffset || (cachedOffset.x === 0 && cachedOffset.y === 0)) && edges.length > 0) {
      const detected = await detectContentOffsetWithRetry(page);
      // Only cache if valid (non-zero)
      if (detected.x > 0 || detected.y > 0) {
        flowOffsets.set(flowKey, detected);
        console.log(`[walker] Content offset for flow "${flowSpId}": (${detected.x}, ${detected.y})`);
      } else {
        // Mark as attempted but failed — will retry on next screen
        flowOffsets.set(flowKey, null);
      }
    }

    // AFTER_TIMEOUT destinations
    const timeoutDestIds = new Set(
      (graph.edges.get(currentId) ?? [])
        .filter((e) => e.trigger === 'AFTER_TIMEOUT')
        .map((e) => e.destinationId),
    );

    // Deduplicate by destination
    const edgesByDest = new Map<string, GraphEdge>();
    for (const edge of edges) {
      if (!edgesByDest.has(edge.destinationId)) edgesByDest.set(edge.destinationId, edge);
    }

    const contentOffset = flowOffsets.get(flowKey) ?? { x: 0, y: 0 };

    for (const [destId, edge] of edgesByDest) {
      const destNode = graph.nodes.get(destId);
      if (!destNode) continue;

      if (!edge.sourceElementBoundingBox) continue;

      const { x: ex, y: ey, width: ew, height: eh } = edge.sourceElementBoundingBox as BoundingBox;
      const frameX = ex - frameBox.x + ew / 2;
      const frameY = ey - frameBox.y + eh / 2;
      const clickX = contentOffset.x + frameX;
      const clickY = contentOffset.y + frameY;

      // Re-navigate to current screen before each click if needed
      let alreadyHere = false;
      try {
        const currentNodeParam = new URL(page.url()).searchParams.get('node-id');
        alreadyHere = currentNodeParam === nodeIdUrl;
      } catch { /* page context closed or bad URL — force re-navigate */ }

      if (!alreadyHere) {
        try {
          await page.goto(protoUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
          await page.waitForSelector('canvas', { timeout: 10_000 });
        } catch {
          continue;
        }
      }

      // Fix 3: settle + canvas stability check before click
      await settleAndStabilize(page);

      console.log(`[walker]   → click (${Math.round(clickX)}, ${Math.round(clickY)}) → "${destNode.name}"`);

      await page.mouse.click(clickX, clickY);

      let actualNodeId: string | null = null;
      try {
        await page.waitForURL((url) => {
          const id = url.searchParams.get('node-id');
          return !!id && id !== nodeIdUrl;
        }, { timeout: navTimeout });

        const rawId = new URL(page.url()).searchParams.get('node-id') ?? '';
        actualNodeId = rawId.replace(/^(\d+)-(\d+)$/, '$1:$2') || null;
      } catch {
        // Navigation didn't happen
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
            expectedDestination: destId,
            expectedName: destNode.name,
            frameX: Math.round(frameX),
            frameY: Math.round(frameY),
            canvasX: Math.round(clickX),
            canvasY: Math.round(clickY),
            trigger: edge.trigger,
          },
        });
        console.log(`[walker]   ✗ No navigation (expected "${destNode.name}")`);
      } else if (actualNodeId !== destId) {
        if (timeoutDestIds.has(actualNodeId)) {
          console.log(`[walker]   ⚠ Navigation to "${graph.nodes.get(actualNodeId)?.name ?? actualNodeId}" matches AFTER_TIMEOUT — inconclusive (timeout race), skipping`);
        } else {
          issues.push({
            id: `runtime-nav-failure-${++issueCounter}`,
            category: 'runtime-nav-failure',
            severity: 'high',
            confidence: 'certain',
            screenId: currentId,
            screenName: currentNode.name,
            nodeId: currentId,
            message: `Click navigated to "${graph.nodes.get(actualNodeId)?.name ?? actualNodeId}" instead of expected "${destNode.name}".`,
            evidence: {
              expectedDestination: destId,
              expectedName: destNode.name,
              actualDestination: actualNodeId,
              actualName: graph.nodes.get(actualNodeId)?.name ?? actualNodeId,
              frameX: Math.round(frameX),
              frameY: Math.round(frameY),
              canvasX: Math.round(clickX),
              canvasY: Math.round(clickY),
            },
          });
          console.log(`[walker]   ✗ Wrong dest: got "${graph.nodes.get(actualNodeId)?.name ?? actualNodeId}", expected "${destNode.name}"`);
        }
      } else {
        console.log(`[walker]   ✓ Navigated to "${destNode.name}"`);
      }
    }
  }

  // Capture video path before closing (Playwright saves video on context close)
  let videoPath: string | undefined;
  if (recordDir) {
    videoPath = await page.video()?.path() ?? undefined;
  }

  await browser.close();

  console.log(`\n[walker] Walked ${screensWalked} screens, found ${issues.length} runtime nav failures.`);
  if (videoPath) {
    console.log(`[walker] Recording saved to: ${videoPath}`);
  }
  return { issues, videoPath };
}
