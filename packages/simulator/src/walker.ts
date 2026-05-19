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
 *   once via screenshot analysis after the first load, then apply it to all clicks:
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

/**
 * Detect the pixel offset of the prototype screen content within the browser
 * viewport by analysing a Playwright screenshot (PNG).
 *
 * The prototype viewer renders a device mockup frame (phone bezel) around the
 * actual screen content. Outside the phone there is pure black (#000000).
 * We scan inward from the edges to find where non-black content begins.
 */
async function detectContentOffset(
  screenshotBuf: Buffer,
): Promise<{ x: number; y: number }> {
  // ---- Minimal PNG decoder ----
  // 8-byte signature, then chunks: [4 len][4 type][N data][4 CRC]
  let pos = 8;
  const idatChunks: Buffer[] = [];
  let imgWidth = 0;
  let imgHeight = 0;

  while (pos < screenshotBuf.length - 8) {
    const len = screenshotBuf.readUInt32BE(pos); pos += 4;
    const type = screenshotBuf.subarray(pos, pos + 4).toString('ascii'); pos += 4;
    const data = screenshotBuf.subarray(pos, pos + len); pos += len + 4; // skip CRC

    if (type === 'IHDR') {
      imgWidth  = data.readUInt32BE(0);
      imgHeight = data.readUInt32BE(4);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  const rowBytes = imgWidth * 4; // RGBA
  const raw = inflateSync(Buffer.concat(idatChunks));
  const pixels = new Uint8Array(imgWidth * imgHeight * 4);
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
      const L = x >= 4 ? dst[x - 4] : 0;
      const U = prev[x];
      const UL = x >= 4 ? prev[x - 4] : 0;
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

  // isBackground: pure black background + dark device bezels (all channels < 50)
  // Screen content is always significantly brighter (white, teal, colors, etc.)
  const isBackground = (x: number, y: number): boolean => {
    const i = (y * imgWidth + x) * 4;
    return pixels[i] < 50 && pixels[i + 1] < 50 && pixels[i + 2] < 50;
  };

  // Scan from left at multiple rows to find leftmost non-black
  let offsetX = 0;
  outer:
  for (let x = 0; x < imgWidth; x++) {
    for (const yFrac of [0.3, 0.5, 0.7]) {
      const y = Math.floor(imgHeight * yFrac);
      if (!isBackground(x, y)) { offsetX = x; break outer; }
    }
  }

  // Scan from top at multiple columns to find topmost non-black
  let offsetY = 0;
  outer:
  for (let y = 0; y < imgHeight; y++) {
    for (const xFrac of [0.3, 0.5, 0.7]) {
      const x = Math.floor(imgWidth * xFrac);
      if (!isBackground(x, y)) { offsetY = y; break outer; }
    }
  }

  return { x: offsetX, y: offsetY };
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
  // Needed so each screen uses the correct starting-point-node-id (which determines
  // which device frame Figma renders)
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
  const flowOffsets = new Map<string, { x: number; y: number }>();

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
    const protoUrl = `${PROTO_BASE}/${fileKey}/?node-id=${nodeIdUrl}&scaling=min-zoom&hide-ui=1${spParam}`;
    try {
      await page.goto(protoUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForSelector('canvas', { timeout: 15_000 });
    } catch {
      console.log(`[walker]   ⚠ Canvas not ready for "${currentNode.name}" — skipping`);
      continue;
    }

    // Settle time — race networkidle against 3s ceiling (Figma has a persistent WebSocket
    // that prevents bare networkidle from ever resolving; the race gives it a chance to
    // settle faster on fast connections while guaranteeing at least 2s for interaction zones).
    await Promise.race([
      page.waitForLoadState('networkidle').then(() => page.waitForTimeout(2_000)).catch(() => {}),
      page.waitForTimeout(3_000),
    ]);

    // All outgoing NAVIGATE edges (to queue non-tappable destinations too)
    const allNavEdges = (graph.edges.get(currentId) ?? []).filter(
      (e) => e.navigation === 'NAVIGATE' && !visited.has(e.destinationId),
    );
    // Queue ALL navigate destinations (auto-transitions included) for graph coverage
    for (const e of allNavEdges) {
      if (!visited.has(e.destinationId)) queue.push(e.destinationId);
    }
    // Only CLICK tappable triggers
    const edges = allNavEdges.filter((e) => TAPPABLE_TRIGGERS.has(e.trigger));

    // Detect content offset for this flow from first screen that has tappable edges
    const flowKey = flowSpId ?? 'default';
    if (!flowOffsets.has(flowKey) && edges.length > 0) {
      const shot = await page.screenshot();
      const detected = await detectContentOffset(shot);
      flowOffsets.set(flowKey, detected);
      console.log(`[walker] Content offset for flow "${flowSpId}": (${detected.x}, ${detected.y})`);
    }

    // AFTER_TIMEOUT destinations for this screen — used to detect false positives where
    // a timeout fires during the click wait and we mistake it for a click-caused navigation.
    const timeoutDestIds = new Set(
      (graph.edges.get(currentId) ?? [])
        .filter((e) => e.trigger === 'AFTER_TIMEOUT')
        .map((e) => e.destinationId),
    );

    // Deduplicate by destination (only click the first element that goes to each dest)
    const edgesByDest = new Map<string, GraphEdge>();
    for (const edge of edges) {
      if (!edgesByDest.has(edge.destinationId)) edgesByDest.set(edge.destinationId, edge);
    }

    for (const [destId, edge] of edgesByDest) {
      const destNode = graph.nodes.get(destId);
      if (!destNode) continue;

      if (!edge.sourceElementBoundingBox) continue;

      const { x: ex, y: ey, width: ew, height: eh } = edge.sourceElementBoundingBox as BoundingBox;
      const frameX = ex - frameBox.x + ew / 2;
      const frameY = ey - frameBox.y + eh / 2;
      const contentOffset = flowOffsets.get(flowKey) ?? { x: 0, y: 0 };
      const clickX = contentOffset.x + frameX;
      const clickY = contentOffset.y + frameY;

      // Re-navigate to current screen before each click.
      // Skip goto if already on the correct screen (first iteration after outer load,
      // or after a failed click that left us on the same URL).
      // Guards: wrap page.url() in try-catch (context may be closed), and always
      // re-navigate if the previous click may have changed the URL.
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

      await Promise.race([
        page.waitForLoadState('networkidle').then(() => page.waitForTimeout(2_000)).catch(() => {}),
        page.waitForTimeout(3_000),
      ]);

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
        // If the actual destination is an AFTER_TIMEOUT destination of this screen,
        // the timeout fired during the click wait — result is inconclusive, skip reporting.
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
