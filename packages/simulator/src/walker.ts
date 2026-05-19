/**
 * Click-only prototype walker
 *
 * Loads the prototype ONCE, then navigates entirely by clicking — like a real
 * user. No page.goto() after initial load = no reloads, no white flashes,
 * no Figma loader. The video shows smooth Figma prototype transitions.
 *
 * Uses phone viewport (430x932) + scale-down-width so Figma fills the screen
 * edge-to-edge with no device frame offset. Click coordinates = simple scale
 * from Figma frame coords to viewport pixels.
 *
 * Algorithm:
 *   1. Load starting point via page.goto() (single initial load)
 *   2. From current screen, find a clickable edge to an unvisited destination
 *   3. Click it. If Figma navigates → we're on the new screen, go to step 2
 *   4. If click fails or no unvisited edges → try BACK navigation or skip
 *   5. Repeat until all reachable screens are visited
 */

import { chromium } from 'playwright';
import { inflateSync } from 'node:zlib';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BoundingBox, GraphEdge, Issue, PrototypeGraph } from '@protoscan/core';

/** Detect content offset from a screenshot — finds where non-black content begins */
async function detectOffset(page: { screenshot: () => Promise<Buffer> }): Promise<{ x: number; y: number }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const buf = await page.screenshot();
    // Minimal PNG decode
    let pos = 8; const idats: Buffer[] = []; let w = 0, h = 0, bpp = 4;
    while (pos < buf.length - 8) {
      const len = buf.readUInt32BE(pos); pos += 4;
      const t = buf.subarray(pos, pos + 4).toString('ascii'); pos += 4;
      const d = buf.subarray(pos, pos + len); pos += len + 4;
      if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bpp = d[9] === 6 ? 4 : 3; }
      else if (t === 'IDAT') idats.push(d);
      else if (t === 'IEND') break;
    }
    const rb = w * bpp; const raw = inflateSync(Buffer.concat(idats));
    const px = new Uint8Array(w * h * bpp); const prev = new Uint8Array(rb);
    const paeth = (a: number, b: number, c: number) => { const p = a+b-c; const pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c); return pa<=pb&&pa<=pc?a:pb<=pc?b:c; };
    for (let y = 0; y < h; y++) {
      const sb = y * (rb + 1); const f = raw[sb]; const dst = px.subarray(y*rb,(y+1)*rb);
      for (let x = 0; x < rb; x++) {
        const byte = raw[sb+1+x]; const L = x>=bpp?dst[x-bpp]:0; const U = prev[x]; const UL = x>=bpp?prev[x-bpp]:0;
        switch(f){case 0:dst[x]=byte;break;case 1:dst[x]=(byte+L)&0xff;break;case 2:dst[x]=(byte+U)&0xff;break;case 3:dst[x]=(byte+((L+U)>>1))&0xff;break;case 4:dst[x]=(byte+paeth(L,U,UL))&0xff;break;default:dst[x]=byte;}
      }
      prev.set(dst);
    }
    const br = (x: number, y: number) => { const i=(y*w+x)*bpp; return Math.max(px[i],px[i+1],px[i+2]); };
    let ox = 0;
    for (let x = 1; x < w-1; x++) { let f = false; for (const yf of [.3,.4,.5,.6,.7]) { const y=Math.floor(h*yf); if(br(x,y)>=50||br(x,y)-br(x-1,y)>40){ox=x;f=true;break;} } if(f)break; }
    let oy = 0;
    for (let y = 1; y < h-1; y++) { let f = false; for (const xf of [.3,.4,.5,.6,.7]) { const x=Math.floor(w*xf); if(br(x,y)>=50||br(x,y)-br(x,y-1)>40){oy=y;f=true;break;} } if(f)break; }
    if (ox > 0 || oy > 0) return { x: ox, y: oy };
    if (attempt < 2) await sleep(2000);
  }
  return { x: 0, y: 0 };
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function walkPrototype(
  graph: PrototypeGraph,
  options: WalkerOptions,
): Promise<WalkResult> {
  const {
    fileKey,
    sessionPath = DEFAULT_SESSION_PATH,
    maxScreens = 50,
    navTimeout = 6_000,
    recordDir,
  } = options;

  const hasSession = existsSync(sessionPath);
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Executable') || msg.includes('playwright install'))
      throw new Error('Chromium not found. Run: npx playwright install chromium');
    throw err;
  }

  const context = await browser.newContext({
    viewport: { width: 800, height: 1100 },
    ...(recordDir ? { recordVideo: { dir: recordDir, size: { width: 800, height: 1100 } } } : {}),
  });

  // Anti-detection + banner hiding
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    const style = document.createElement('style');
    style.textContent = `
      [class*="cookie"], [class*="banner"], [class*="notification"],
      [class*="CookieBanner"], [class*="BottomBanner"], [class*="HardwareAcceleration"] {
        display: none !important;
      }
      div[style*="position: fixed"][style*="bottom"],
      div[style*="position:fixed"][style*="bottom"] {
        display: none !important;
      }
    `;
    document.addEventListener('DOMContentLoaded', () => {
      document.head.appendChild(style);
      setTimeout(() => {
        document.querySelectorAll('button').forEach(btn => {
          const t = (btn.textContent || '').toLowerCase();
          if (t.includes('allow') || t.includes('accept') || t.includes('got it')) btn.click();
        });
        document.querySelectorAll('div').forEach(div => {
          const r = div.getBoundingClientRect();
          if (r.bottom > window.innerHeight - 80 && r.width > 300 && r.height < 150 && r.height > 20)
            div.style.display = 'none';
        });
      }, 2000);
    });
  });

  if (hasSession) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
      cookies: Array<{ name: string; value: string; [k: string]: unknown }>;
    };
    await context.addCookies(session.cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain as string | undefined,
      path: c.path as string | undefined, httpOnly: c.httpOnly as boolean | undefined,
      secure: true, sameSite: 'None' as const,
    })));
  }

  const page = await context.newPage();
  await page.route('**', route => {
    const url = new URL(route.request().url());
    if (url.hostname.endsWith('figma.com') || url.hostname.endsWith('amazonaws.com'))
      route.continue();
    else
      route.abort('blockedbyclient');
  });

  const issues: Issue[] = [];
  let issueCounter = 0;

  // Map each screen to its flow starting point
  const nodeToFlow = new Map<string, string>();
  for (const sp of graph.startingPoints) {
    const q = [sp.nodeId]; const seen = new Set<string>();
    while (q.length) {
      const id = q.shift()!;
      if (seen.has(id)) continue; seen.add(id);
      if (!nodeToFlow.has(id)) nodeToFlow.set(id, sp.nodeId);
      for (const e of graph.edges.get(id) ?? []) q.push(e.destinationId);
    }
  }

  // Find starting point
  const startId = graph.startingPoints[0]?.nodeId;
  if (!startId || !graph.nodes.get(startId)?.boundingBox) {
    await browser.close();
    return { issues };
  }

  // === SINGLE PAGE LOAD ===
  const startFlow = nodeToFlow.get(startId) ?? startId;
  const startUrl = `${PROTO_BASE}/${fileKey}/?node-id=${startId.replace(':', '-')}&scaling=contain&hide-ui=1&starting-point-node-id=${startFlow.replace(':', '-')}`;

  console.log(`[walker] Loading prototype: "${graph.nodes.get(startId)?.name}"...`);
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await page.waitForSelector('canvas', { timeout: 20_000 });
  } catch {
    console.log('[walker] ⚠ Failed to load prototype');
    await browser.close();
    return { issues };
  }

  // Wait for full render (headless needs ~10s for Figma proto)
  await sleep(10_000);
  // Save debug screenshot to see what we're working with
  if (recordDir) {
    const debugPath = resolve(recordDir, 'debug-headless.png');
    await page.screenshot({ path: debugPath });
    console.log(`[walker] Debug screenshot: ${debugPath}`);
  }
  const offset = await detectOffset(page);
  console.log(`[walker] Offset: (${offset.x}, ${offset.y})`);
  if (offset.x === 0 && offset.y === 0) {
    console.log('[walker] ⚠ Offset detection failed — prototype may not have loaded');
  }
  console.log('[walker] Navigating by clicks only (no reloads)...');

  const visited = new Set<string>();
  const clickedEdges = new Set<string>(); // "source:dest" keys
  let currentScreenId = startId;
  let screensVisited = 1;
  visited.add(startId);

  /** Read current screen from URL */
  function getCurrentNodeId(): string | null {
    try {
      const raw = new URL(page.url()).searchParams.get('node-id') ?? '';
      return raw.replace(/^(\d+)-(\d+)$/, '$1:$2') || null;
    } catch { return null; }
  }

  /** Get all clickable edges from a screen, preferring unvisited destinations */
  function getEdges(screenId: string): GraphEdge[] {
    return (graph.edges.get(screenId) ?? [])
      .filter(e =>
        e.navigation === 'NAVIGATE' &&
        TAPPABLE_TRIGGERS.has(e.trigger) &&
        e.sourceElementBoundingBox &&
        !clickedEdges.has(`${screenId}:${e.destinationId}`),
      );
  }

  /** Click an element and wait for navigation */
  async function clickAndWait(
    screenId: string, edge: GraphEdge,
  ): Promise<string | null> {
    const node = graph.nodes.get(screenId)!;
    const frameBox = node.boundingBox!;
    const bb = edge.sourceElementBoundingBox as BoundingBox;

    // Offset-based coords: content starts at (offset.x, offset.y)
    const clickX = offset.x + (bb.x - frameBox.x + bb.width / 2);
    const clickY = offset.y + (bb.y - frameBox.y + bb.height / 2);

    const nodeIdUrl = screenId.replace(':', '-');
    clickedEdges.add(`${screenId}:${edge.destinationId}`);

    const destName = graph.nodes.get(edge.destinationId)?.name ?? edge.destinationId;
    console.log(`[walker]   → click (${Math.round(clickX)}, ${Math.round(clickY)}) → "${destName}"`);

    await page.mouse.click(clickX, clickY);

    // Wait for URL to change (Figma updates node-id on navigation)
    try {
      await page.waitForURL(url => {
        const id = url.searchParams.get('node-id');
        return !!id && id !== nodeIdUrl;
      }, { timeout: navTimeout });

      // Small pause for Figma transition animation
      await sleep(600);

      return getCurrentNodeId();
    } catch {
      return null; // No navigation
    }
  }

  // === CLICK-ONLY WALK ===
  // DFS: keep exploring from current screen via clicks. When stuck, use
  // browser back (which Figma supports) to retrace steps.

  const navStack: string[] = [startId]; // screens we've navigated to, for back-tracking
  let totalActions = 0;
  const MAX_ACTIONS = maxScreens * 5; // safety limit

  while (totalActions < MAX_ACTIONS && screensVisited < maxScreens) {
    totalActions++;
    const currentNode = graph.nodes.get(currentScreenId);
    if (!currentNode?.boundingBox) break;

    // Get AFTER_TIMEOUT destinations (for false positive detection)
    const timeoutDests = new Set(
      (graph.edges.get(currentScreenId) ?? [])
        .filter(e => e.trigger === 'AFTER_TIMEOUT')
        .map(e => e.destinationId),
    );

    // Find unclicked edges, preferring edges to unvisited screens
    const allEdges = getEdges(currentScreenId);
    const toUnvisited = allEdges.filter(e => !visited.has(e.destinationId));
    const edge = toUnvisited[0] ?? allEdges[0];

    if (!edge) {
      // No more edges from this screen — go back
      navStack.pop();
      if (navStack.length === 0) break; // Nowhere to go

      console.log(`[walker]   ← back`);
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
      await sleep(1_000);

      const backId = getCurrentNodeId();
      if (backId) {
        currentScreenId = backId;
      } else {
        // goBack didn't work — we're stuck
        break;
      }
      continue;
    }

    const destId = edge.destinationId;
    const destName = graph.nodes.get(destId)?.name ?? destId;
    const actualId = await clickAndWait(currentScreenId, edge);

    if (actualId === null) {
      // Click didn't navigate — record issue, try next edge
      issues.push({
        id: `runtime-nav-failure-${++issueCounter}`,
        category: 'runtime-nav-failure', severity: 'high', confidence: 'certain',
        screenId: currentScreenId, screenName: currentNode.name, nodeId: currentScreenId,
        message: `Click on "${currentNode.name}" did not navigate to "${destName}".`,
        evidence: { expectedDestination: destId, expectedName: destName, trigger: edge.trigger },
      });
      console.log(`[walker]   ✗ No navigation`);
      continue; // Stay on current screen, try next edge
    }

    if (actualId === destId) {
      // Successful click navigation!
      console.log(`[walker]   ✓ → "${destName}"`);
      currentScreenId = actualId;
      navStack.push(actualId);
      if (!visited.has(actualId)) {
        visited.add(actualId);
        screensVisited++;
        console.log(`[walker] Screen ${screensVisited}: "${destName}" (via click)`);
      }
    } else if (timeoutDests.has(actualId)) {
      // AFTER_TIMEOUT transition — not a real click failure
      console.log(`[walker]   ⚠ AFTER_TIMEOUT → "${graph.nodes.get(actualId)?.name}" (skipping)`);
      currentScreenId = actualId;
      navStack.push(actualId);
      if (!visited.has(actualId)) {
        visited.add(actualId);
        screensVisited++;
      }
    } else {
      // Wrong destination
      const actualName = graph.nodes.get(actualId)?.name ?? actualId;
      issues.push({
        id: `runtime-nav-failure-${++issueCounter}`,
        category: 'runtime-nav-failure', severity: 'high', confidence: 'certain',
        screenId: currentScreenId, screenName: currentNode.name, nodeId: currentScreenId,
        message: `Click navigated to "${actualName}" instead of "${destName}".`,
        evidence: {
          expectedDestination: destId, expectedName: destName,
          actualDestination: actualId, actualName,
        },
      });
      console.log(`[walker]   ✗ Wrong: "${actualName}"`);
      // We're now on actualId — continue from there
      currentScreenId = actualId;
      navStack.push(actualId);
      if (!visited.has(actualId)) {
        visited.add(actualId);
        screensVisited++;
      }
    }
  }

  let videoPath: string | undefined;
  if (recordDir) videoPath = await page.video()?.path() ?? undefined;
  await browser.close();

  console.log(`\n[walker] Visited ${screensVisited} screens via clicks (0 reloads).`);
  console.log(`[walker] Found ${issues.length} runtime nav failures.`);
  if (videoPath) console.log(`[walker] Recording: ${videoPath}`);
  return { issues, videoPath };
}
