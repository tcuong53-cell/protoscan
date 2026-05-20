/**
 * Click-only prototype walker
 *
 * Loads the prototype ONCE, then navigates entirely by clicking — like a real
 * user. No page.goto() after initial load = no reloads, no white flashes,
 * no Figma loader. The video shows smooth Figma prototype transitions.
 *
 * Key design decisions:
 *   - Viewport 430x932 (iPhone 15 Pro aspect) + scale-down-width scaling
 *   - Figma renders content at 1:1 scale centered in viewport
 *   - Scale computed from content area / frame dimensions
 *   - AFTER_TIMEOUT transitions handled by waiting for URL change
 *   - DFS with browser back for backtracking
 *   - Cookie/hardware banners explicitly dismissed
 */

import { chromium } from 'playwright';
import { inflateSync, deflateSync } from 'node:zlib';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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

// Viewport padding added around the frame (Figma device chrome needs ~40px)
const VP_PAD_X = 40;
const VP_PAD_Y = 88;
// Viewport bounds — stay within reasonable screen sizes
const VP_MIN_W = 320;
const VP_MIN_H = 480;
const VP_MAX_W = 1920;
const VP_MAX_H = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Dismiss Figma cookie/hardware banners by clicking buttons and hiding overlays.
 *  Hides fixed/absolute positioned elements that are NOT inside the prototype canvas. */
async function dismissBanners(page: { evaluate: (fn: string) => Promise<unknown> }): Promise<void> {
  await page.evaluate(`
    (() => {
      document.querySelectorAll('button').forEach(btn => {
        const t = (btn.textContent || '').toLowerCase();
        if (t.includes('allow') || t.includes('accept') || t.includes('got it')
            || t.includes('do not allow') || t.includes('dismiss')) btn.click();
      });
      const viewer = document.getElementById('viewerContainer');
      document.querySelectorAll('div').forEach(div => {
        if (viewer && viewer.contains(div)) return;
        const s = window.getComputedStyle(div);
        const r = div.getBoundingClientRect();
        if ((s.position === 'fixed' || s.position === 'absolute') && r.bottom > window.innerHeight - 100 && r.height < 200 && r.height > 20) {
          div.style.display = 'none';
        }
      });
    })()
  `);
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

  // Find starting point — needed to compute viewport dimensions
  const startId = graph.startingPoints[0]?.nodeId;
  const startNode = startId ? graph.nodes.get(startId) : undefined;
  if (!startId || !startNode?.boundingBox) {
    await browser.close();
    return { issues };
  }

  const frameW = startNode.boundingBox.width;
  const frameH = startNode.boundingBox.height;

  // Dynamic viewport: match frame aspect ratio with padding for device chrome
  const vpW = Math.min(Math.max(frameW + VP_PAD_X, VP_MIN_W), VP_MAX_W);
  const vpH = Math.min(Math.max(frameH + VP_PAD_Y, VP_MIN_H), VP_MAX_H);

  const context = await browser.newContext({
    viewport: { width: vpW, height: vpH },
    ...(recordDir ? { recordVideo: { dir: recordDir, size: { width: vpW, height: vpH } } } : {}),
  });

  let videoStartTime = Date.now();

  // Anti-detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  if (hasSession) {
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
      cookies: Array<{ name: string; value: string; [k: string]: unknown }>;
    };
    // Only inject cookies with Figma-related domains
    const figmaCookies = session.cookies.filter(c => {
      const domain = (c.domain as string) ?? '';
      return domain.endsWith('.figma.com') || domain === 'figma.com';
    });
    await context.addCookies(figmaCookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain as string | undefined,
      path: c.path as string | undefined, httpOnly: c.httpOnly as boolean | undefined,
      secure: true, sameSite: 'None' as const,
    })));
  }

  const page = await context.newPage();

  // === SINGLE PAGE LOAD ===
  const startFlow = nodeToFlow.get(startId) ?? startId;
  const startUrl = `${PROTO_BASE}/${fileKey}/?node-id=${startId.replace(':', '-')}&scaling=scale-down-width&hide-ui=1&hotspot-hints=0&starting-point-node-id=${startFlow.replace(':', '-')}`;

  console.log(`[walker] Loading prototype: "${startNode.name}" (frame ${frameW}x${frameH}, viewport ${vpW}x${vpH})...`);
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('canvas', { timeout: 20_000 });
  } catch {
    console.log('[walker] ⚠ Failed to load prototype');
    await browser.close();
    return { issues };
  }

  // Wait for prototype to fully initialize — canvas renders before JS handlers attach.
  // Hybrid: wait for network idle first, then ensure minimum 12s total from page load.
  // On fast connections this saves ~3s vs flat 15s. On slow, networkidle adds needed time.
  const loadStart = Date.now();
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  const remaining = Math.max(12_000 - (Date.now() - loadStart), 3_000);
  await sleep(remaining);

  // Offset + scale detection (lazy — runs after first real screen loads)
  let offset = { x: 0, y: 0 };
  let scale = vpW / frameW; // theoretical default
  let offsetDetected = false;

  async function ensureOffset(): Promise<void> {
    if (offsetDetected) return;

    // Dismiss banners first
    await dismissBanners(page as any);
    await sleep(500);
    await dismissBanners(page as any);

    // Detect offset using screenshot with high-contrast edge detection.
    // The prototype viewer may have a device frame (bezel) that confuses simple brightness.
    // We use derivative-based detection: find the first column with a SHARP brightness jump.
    for (let attempt = 0; attempt < 5; attempt++) {
      const detected = await detectOffset(page);
      const contentW = vpW - 2 * detected.x;
      // Valid: content fills > 60% of viewport and offset is reasonable
      // (for a phone-sized frame in phone viewport, offset should be >= ~10px)
      const minOffset = Math.max(Math.floor((vpW - frameW) / 2) - 5, 0);
      if (contentW > vpW * 0.6 && detected.x >= minOffset) {
        offset = detected;
        scale = contentW / frameW;
        offsetDetected = true;
        console.log(`[walker] Offset: (${offset.x}, ${offset.y}), scale: ${scale.toFixed(3)}`);
        if (recordDir) {
          await page.screenshot({ path: resolve(recordDir, 'debug-offset.png') });
        }
        return;
      }
      // If detected offset is too small (bezel detected as content), use theoretical center
      if (detected.x < minOffset && contentW > vpW * 0.6) {
        // Guard: when frame is wider than viewport, Figma scales down — no centering offset
        const theoreticalOx = frameW >= vpW ? 0 : Math.round((vpW - frameW) / 2);
        const theoreticalOy = detected.y > 10 ? detected.y : Math.round((vpH - frameH) / 2);
        offset = { x: theoreticalOx, y: Math.max(theoreticalOy, 0) };
        scale = frameW >= vpW ? vpW / frameW : (frameW > 0 ? (vpW - 2 * theoreticalOx) / frameW : 1);
        offsetDetected = true;
        console.log(`[walker] Offset: (${offset.x}, ${offset.y}), scale: ${scale.toFixed(3)} (theoretical — device frame detected)`);
        if (recordDir) {
          await page.screenshot({ path: resolve(recordDir, 'debug-offset.png') });
        }
        return;
      }
      await sleep(2000);
    }

    // Fallback: use theoretical centered offset (guard for wide frames)
    const theoreticalOx = frameW >= vpW ? 0 : Math.round((vpW - frameW) / 2);
    const theoreticalOy = frameH >= vpH ? 0 : Math.round((vpH - frameH) / 2);
    offset = { x: theoreticalOx, y: theoreticalOy };
    scale = frameW >= vpW ? vpW / frameW : (frameW > 0 ? (vpW - 2 * theoreticalOx) / frameW : 1);
    offsetDetected = true;
    console.log(`[walker] ⚠ Offset detection failed after 10s — using theoretical (${offset.x}, ${offset.y}), scale ${scale.toFixed(3)}`);
    if (recordDir) {
      await page.screenshot({ path: resolve(recordDir, 'debug-offset-fallback.png') });
    }
  }

  console.log('[walker] Navigating by clicks (no reloads)...');

  const visited = new Set<string>();
  const clickedEdges = new Set<string>();
  const exhausted = new Set<string>();
  let currentScreenId = startId;
  let screensVisited = 1;
  visited.add(startId);

  function getCurrentNodeId(): string | null {
    try {
      const raw = new URL(page.url()).searchParams.get('node-id') ?? '';
      return raw.replace(/^(\d+)-(\d+)$/, '$1:$2') || null;
    } catch { return null; }
  }

  function getClickableEdges(screenId: string): GraphEdge[] {
    return (graph.edges.get(screenId) ?? [])
      .filter(e =>
        e.navigation === 'NAVIGATE' &&
        TAPPABLE_TRIGGERS.has(e.trigger) &&
        e.sourceElementBoundingBox &&
        !clickedEdges.has(`${screenId}:${e.destinationId}`) &&
        graph.nodes.has(e.destinationId), // skip cross-page destinations
      );
  }

  function getTimeoutEdges(screenId: string): GraphEdge[] {
    return (graph.edges.get(screenId) ?? [])
      .filter(e => e.trigger === 'AFTER_TIMEOUT' && e.navigation === 'NAVIGATE' &&
        graph.nodes.has(e.destinationId));
  }

  // Track clicks for ffmpeg post-processing (time relative to video start)
  const clickEvents: Array<{ x: number; y: number; t: number }> = [];
  // Video starts recording when context is created, which was above
  // We'll compute relative to a reference set right after context creation

  async function clickAndWait(screenId: string, edge: GraphEdge): Promise<string | null> {
    await ensureOffset();

    const node = graph.nodes.get(screenId)!;
    const frameBox = node.boundingBox!;
    const bb = edge.sourceElementBoundingBox as BoundingBox;

    const relX = bb.x - frameBox.x + bb.width / 2;
    const relY = bb.y - frameBox.y + bb.height / 2;
    const clickX = offset.x + relX * scale;
    const clickY = offset.y + relY * scale;

    const nodeIdUrl = screenId.replace(':', '-');
    clickedEdges.add(`${screenId}:${edge.destinationId}`);

    const destName = graph.nodes.get(edge.destinationId)?.name ?? edge.destinationId;
    console.log(`[walker]   → click (${Math.round(clickX)}, ${Math.round(clickY)}) → "${destName}"`);

    // Dismiss any banners that might be covering the click area
    await dismissBanners(page as any);

    // Record click for post-processing (time relative to video start)
    clickEvents.push({ x: Math.round(clickX), y: Math.round(clickY), t: (Date.now() - videoStartTime) / 1000 });

    // Pause so the viewer can see the current screen before clicking
    await sleep(600);

    // Hover first so Figma's canvas registers the pointer position
    await page.mouse.move(clickX, clickY, { steps: 5 });
    await sleep(200);
    await page.mouse.click(clickX, clickY);

    try {
      await page.waitForURL(url => {
        const id = url.searchParams.get('node-id');
        return !!id && id !== nodeIdUrl;
      }, { timeout: navTimeout });
      await sleep(1_200); // Let Figma transition animate fully
      return getCurrentNodeId();
    } catch {
      return null;
    }
  }

  async function waitForTimeout(screenId: string): Promise<string | null> {
    const nodeIdUrl = screenId.replace(':', '-');
    console.log(`[walker]   ⏳ waiting for timeout transition...`);
    try {
      await page.waitForURL(url => {
        const id = url.searchParams.get('node-id');
        return !!id && id !== nodeIdUrl;
      }, { timeout: 15_000 });
      await sleep(800);
      return getCurrentNodeId();
    } catch {
      return null;
    }
  }

  // === DFS WALK ===
  const navStack: string[] = [startId];
  let totalActions = 0;
  let actionsSinceNewScreen = 0;
  const MAX_ACTIONS = maxScreens * 5;
  const MAX_STALE = 15;

  while (totalActions < MAX_ACTIONS && screensVisited < maxScreens) {
    totalActions++;
    actionsSinceNewScreen++;

    if (actionsSinceNewScreen > MAX_STALE) {
      console.log(`[walker] No progress in ${MAX_STALE} actions — stopping`);
      break;
    }

    const currentNode = graph.nodes.get(currentScreenId);
    if (!currentNode?.boundingBox) break;
    const screenName = currentNode.name;

    // --- Handle AFTER_TIMEOUT transitions ---
    const timeoutEdges = getTimeoutEdges(currentScreenId);
    if (timeoutEdges.length > 0 && !exhausted.has(currentScreenId)) {
      const clickable = getClickableEdges(currentScreenId);
      const hasUsefulClicks = clickable.some(e =>
        !timeoutEdges.some(t => t.destinationId === e.destinationId)
      );
      if (!hasUsefulClicks) {
        const actualId = await waitForTimeout(currentScreenId);
        if (actualId) {
          const actualName = graph.nodes.get(actualId)?.name ?? actualId;
          console.log(`[walker]   ✓ timeout → "${actualName}"`);
          exhausted.add(currentScreenId);
          currentScreenId = actualId;
          navStack.push(actualId);
          if (!visited.has(actualId)) {
            visited.add(actualId);
            screensVisited++;
            actionsSinceNewScreen = 0;
            console.log(`[walker] Screen ${screensVisited}: "${actualName}" (via timeout)`);
          }
          continue;
        } else {
          exhausted.add(currentScreenId);
        }
      }
    }

    const timeoutDests = new Set(timeoutEdges.map(e => e.destinationId));

    // Find edges, preferring unvisited destinations
    const allEdges = getClickableEdges(currentScreenId);
    const toUnvisited = allEdges.filter(e => !visited.has(e.destinationId));
    const edge = toUnvisited[0] ?? allEdges[0];

    if (!edge) {
      exhausted.add(currentScreenId);
      navStack.pop();
      while (navStack.length > 0 && exhausted.has(navStack[navStack.length - 1])) {
        navStack.pop();
      }
      if (navStack.length === 0) break;

      const backTarget = graph.nodes.get(navStack[navStack.length - 1])?.name ?? '';
      console.log(`[walker]   ← back to "${backTarget}"`);
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
      await sleep(1_200);

      const backId = getCurrentNodeId();
      if (backId) {
        currentScreenId = backId;
      } else {
        break;
      }
      continue;
    }

    const destId = edge.destinationId;
    const destName = graph.nodes.get(destId)?.name ?? destId;
    const actualId = await clickAndWait(currentScreenId, edge);

    if (actualId === null) {
      issues.push({
        id: `runtime-nav-failure-${++issueCounter}`,
        category: 'runtime-nav-failure', severity: 'high', confidence: 'certain',
        screenId: currentScreenId, screenName, nodeId: currentScreenId,
        message: `Click on "${screenName}" did not navigate to "${destName}".`,
        evidence: { expectedDestination: destId, expectedName: destName, trigger: edge.trigger },
      });
      console.log(`[walker]   ✗ No navigation (expected "${destName}")`);

      if (recordDir && issueCounter <= 3) {
        await page.screenshot({ path: resolve(recordDir, `debug-fail-${issueCounter}.png`) });
      }
      continue;
    }

    if (actualId === destId) {
      const name = graph.nodes.get(actualId)?.name ?? actualId;
      console.log(`[walker]   ✓ → "${name}"`);
      currentScreenId = actualId;
      navStack.push(actualId);
      if (!visited.has(actualId)) {
        visited.add(actualId);
        screensVisited++;
        actionsSinceNewScreen = 0;
        console.log(`[walker] Screen ${screensVisited}: "${name}" (via click)`);
      }
    } else if (timeoutDests.has(actualId)) {
      const name = graph.nodes.get(actualId)?.name ?? actualId;
      console.log(`[walker]   ⚠ timeout race → "${name}"`);
      currentScreenId = actualId;
      navStack.push(actualId);
      if (!visited.has(actualId)) {
        visited.add(actualId);
        screensVisited++;
        actionsSinceNewScreen = 0;
      }
    } else {
      const actualName = graph.nodes.get(actualId)?.name ?? actualId;
      issues.push({
        id: `runtime-nav-failure-${++issueCounter}`,
        category: 'runtime-nav-failure', severity: 'high', confidence: 'certain',
        screenId: currentScreenId, screenName, nodeId: currentScreenId,
        message: `Click navigated to "${actualName}" instead of "${destName}".`,
        evidence: {
          expectedDestination: destId, expectedName: destName,
          actualDestination: actualId, actualName,
        },
      });
      console.log(`[walker]   ✗ Wrong: "${actualName}" (expected "${destName}")`);
      currentScreenId = actualId;
      navStack.push(actualId);
      if (!visited.has(actualId)) {
        visited.add(actualId);
        screensVisited++;
        actionsSinceNewScreen = 0;
      }
    }
  }

  let videoPath: string | undefined;
  if (recordDir) videoPath = await page.video()?.path() ?? undefined;
  await browser.close();

  // Post-process video: add click indicators with ffmpeg
  if (videoPath && clickEvents.length > 0) {
    videoPath = await addClickIndicators(videoPath, clickEvents);
  }

  // Count cross-page edges that were skipped
  let crossPageCount = 0;
  for (const [screenId, edges] of graph.edges) {
    for (const e of edges) {
      if (e.navigation === 'NAVIGATE' && !graph.nodes.has(e.destinationId)) crossPageCount++;
    }
  }

  console.log(`\n[walker] Visited ${screensVisited} screens (0 reloads).`);
  console.log(`[walker] Found ${issues.length} runtime nav failures.`);
  if (crossPageCount > 0) console.log(`[walker] Skipped ${crossPageCount} cross-page edges (destinations outside scanned page).`);
  if (videoPath) console.log(`[walker] Recording: ${videoPath}`);
  return { issues, videoPath };
}

// --- Click indicator post-processing ---

async function addClickIndicators(
  inputPath: string,
  clicks: Array<{ x: number; y: number; t: number }>,
): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { dirname, join } = await import('node:path');
  const execFileAsync = promisify(execFile);

  // Check ffmpeg is available
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5_000 });
  } catch {
    console.log('[walker] ffmpeg not found — skipping click indicators');
    return inputPath;
  }

  const dir = dirname(inputPath);

  // Generate a semi-transparent circle PNG (48x48 RGBA) for the touch indicator
  const circleSize = 48;
  const circlePath = join(dir, '_touch.png');
  generateCirclePng(circlePath, circleSize);

  // Build filter chain: overlay the circle PNG at each click position with timing
  const dur = 0.4;
  const r = circleSize / 2;
  let filter = `[0:v]null[base]`;
  for (let i = 0; i < clicks.length; i++) {
    const { x, y, t } = clicks[i];
    const ox = x - r;
    const oy = y - r;
    const label = i === clicks.length - 1 ? '[out]' : `[v${i}]`;
    const input = i === 0 ? '[base]' : `[v${i - 1}]`;
    filter += `;${input}[1:v]overlay=x=${ox}:y=${oy}:enable='between(t,${t.toFixed(2)},${(t + dur).toFixed(2)})'${label}`;
  }

  const outPath = resolve(dir, 'walkthrough.webm');

  console.log(`[walker] Adding touch indicators to video (${clicks.length} taps)...`);

  try {
    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-i', circlePath,
      '-filter_complex', filter,
      '-map', '[out]',
      '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
      outPath, '-y',
    ], { timeout: 300_000 });
    console.log(`[walker] Final video: ${outPath}`);
    try { unlinkSync(circlePath); } catch { /* ignore */ }
    return outPath;
  } catch (err) {
    const stderr = err instanceof Error && 'stderr' in err ? (err as any).stderr?.toString().slice(-300) : '';
    console.log(`[walker] ffmpeg overlay failed, falling back to drawtext: ${stderr?.slice(-100) || err}`);
    try { unlinkSync(circlePath); } catch { /* ignore */ }

    // Fallback: use drawtext with Unicode circle character
    const fallbackFilter = clicks.map(({ x, y, t: ct }) => {
      const en = `enable='between(t,${ct.toFixed(2)},${(ct + dur).toFixed(2)})'`;
      return `drawtext=text='●':fontsize=40:fontcolor=white@0.55:x=${x - 14}:y=${y - 20}:${en}`;
    }).join(',');
    try {
      await execFileAsync('ffmpeg', [
        '-i', inputPath,
        '-vf', fallbackFilter,
        '-c:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
        outPath, '-y',
      ], { timeout: 300_000 });
      return outPath;
    } catch {
      return inputPath;
    }
  }
}

/** Generate a minimal RGBA PNG with a semi-transparent circle */
function generateCirclePng(filePath: string, size: number): void {
  const r = size / 2;
  const rOuter = r - 1;      // outer edge
  const rInner = r - 3;      // start of anti-alias band

  // RGBA scanlines with filter byte
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // no filter
    for (let x = 0; x < size; x++) {
      const dx = x - r + 0.5;
      const dy = y - r + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const px = row + 1 + x * 4;

      if (dist <= rInner) {
        // Inner circle: white with 45% opacity
        raw[px] = 255; raw[px + 1] = 255; raw[px + 2] = 255; raw[px + 3] = 115;
      } else if (dist <= rOuter) {
        // Anti-alias edge: fade out
        const t = 1 - (dist - rInner) / (rOuter - rInner);
        raw[px] = 255; raw[px + 1] = 255; raw[px + 2] = 255; raw[px + 3] = Math.round(115 * t);
      } else {
        // Outside: fully transparent
        raw[px] = 0; raw[px + 1] = 0; raw[px + 2] = 0; raw[px + 3] = 0;
      }
    }
  }

  const compressed = deflateSync(raw);

  // Build PNG
  const crc32 = (data: Buffer): number => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      c ^= data[i];
      for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeB = Buffer.from(type, 'ascii');
    const payload = Buffer.concat([typeB, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(payload));
    return Buffer.concat([len, payload, crc]);
  };

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const iend = Buffer.alloc(0);

  writeFileSync(filePath, Buffer.concat([
    sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', iend),
  ]));
}

// --- Offset detection ---

async function detectOffset(page: { screenshot: () => Promise<Buffer> }): Promise<{ x: number; y: number }> {
  const buf = await page.screenshot();
  let pos = 8; const idats: Buffer[] = []; let w = 0, h = 0, bpp = 4;
  while (pos < buf.length - 8) {
    const len = buf.readUInt32BE(pos); pos += 4;
    const t = buf.subarray(pos, pos + 4).toString('ascii'); pos += 4;
    const d = buf.subarray(pos, pos + len); pos += len + 4;
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bpp = d[9] === 6 ? 4 : 3; }
    else if (t === 'IDAT') idats.push(d);
    else if (t === 'IEND') break;
  }
  if (w === 0 || h === 0) return { x: 0, y: 0 };

  const rb = w * bpp; const raw = inflateSync(Buffer.concat(idats));
  const px = new Uint8Array(w * h * bpp); const prev = new Uint8Array(rb);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const sb = y * (rb + 1); const f = raw[sb];
    const dst = px.subarray(y * rb, (y + 1) * rb);
    for (let x = 0; x < rb; x++) {
      const byte = raw[sb + 1 + x];
      const L = x >= bpp ? dst[x - bpp] : 0;
      const U = prev[x];
      const UL = x >= bpp ? prev[x - bpp] : 0;
      switch (f) {
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

  const brightness = (x: number, y: number) => {
    const i = (y * w + x) * bpp;
    return Math.max(px[i], px[i + 1], px[i + 2]);
  };

  let ox = 0;
  for (let x = 1; x < w - 1; x++) {
    let hits = 0;
    for (const yf of [.25, .35, .45, .55, .65, .75]) {
      const y = Math.floor(h * yf);
      if (brightness(x, y) >= 40) hits++;
    }
    if (hits >= 3) { ox = x; break; }
  }

  let oy = 0;
  for (let y = 1; y < h - 1; y++) {
    let hits = 0;
    for (const xf of [.25, .35, .45, .55, .65, .75]) {
      const x = Math.floor(w * xf);
      if (brightness(x, y) >= 40) hits++;
    }
    if (hits >= 3) { oy = y; break; }
  }

  return { x: ox, y: oy };
}
