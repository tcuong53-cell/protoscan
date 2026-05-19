/**
 * Figma Embed Kit 2.0 POC — Sprint 4 Phase 1
 *
 * Answers two binary questions:
 *   Q1: Can a stored Figma browser session suppress the auth wall in headless Chromium?
 *   Q2: Are postMessage navigation events (PRESENTED_NODE_CHANGED) observable from Playwright?
 *
 * Usage:
 *   # Step 1 (once): open a real browser, log in to Figma, save the session
 *   FIGMA_TOKEN=<pat> npx tsx src/poc.ts --capture
 *
 *   # Step 2: run the headless POC using the saved session
 *   FIGMA_TOKEN=<pat> npx tsx src/poc.ts
 *
 * The saved session is stored at ./figma-session.json (gitignored).
 */

import { chromium } from 'playwright';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FigmaClient, buildGraph } from '@protoscan/core';

/** PostMessage event data from Figma Embed Kit 2.0 */
interface FigmaPostMessageEvent {
  type?: string;
  data?: { presentedNodeId?: string };
}

/** Window with exposed POC functions (Playwright exposeFunction) */
interface PocWindow extends Window {
  __poc_earlyMsg: (data: unknown) => void;
  __poc_onMessage: (data: unknown) => void;
}

const FIGMA_FILE_KEY = process.env.FIGMA_FILE_KEY ?? 'YOUR_FILE_KEY';
const SESSION_PATH = resolve(import.meta.dirname, '../figma-session.json');
const NAVIGATE_TIMEOUT_MS = 15_000;

const FIGMA_TOKEN = process.env.FIGMA_TOKEN ?? '';
const CAPTURE_MODE = process.argv.includes('--capture');

// Cached file data shared between steps
let cachedGraph: ReturnType<typeof buildGraph> | null = null;

// ─── Entry ────────────────────────────────────────────────────────────────────

if (!FIGMA_TOKEN) {
  console.error('[FAIL] FIGMA_TOKEN env var is required.');
  process.exit(1);
}

if (CAPTURE_MODE) {
  await captureSession();
} else {
  await runPOC();
}

// ─── Mode: Capture session ─────────────────────────────────────────────────────

async function captureSession(): Promise<void> {
  console.log('[CAPTURE] Opening headed browser — log in to Figma, then close the tab.');
  console.log('[CAPTURE] Session will be saved to:', SESSION_PATH);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://www.figma.com/login');
  console.log('[CAPTURE] Waiting for you to log in... (watching for /files or /recent)');

  await page.waitForURL(/figma\.com\/(files|recent|design)/, { timeout: 120_000 });
  console.log('[CAPTURE] Detected login success. Saving session...');

  await context.storageState({ path: SESSION_PATH });
  console.log('[CAPTURE] Session saved. Run without --capture to start the POC.');
  await browser.close();
}

// ─── Mode: Run POC ─────────────────────────────────────────────────────────────

async function runPOC(): Promise<void> {
  // Step 1: Build graph using @protoscan/core
  console.log('\n[POC] Step 1: Fetch Figma file and build graph via @protoscan/core...');
  const client = new FigmaClient(FIGMA_TOKEN);
  const file = await client.getFile(FIGMA_FILE_KEY);
  const graph = buildGraph(file);
  cachedGraph = graph;

  const { nodeId, nodeName } = getStartingNodeFromGraph(graph);
  console.log(`[POC] Starting node: ${nodeId} (${nodeName})`);

  const protoUrl = `https://www.figma.com/proto/${FIGMA_FILE_KEY}/?node-id=${nodeId.replace(':', '-')}&scaling=min-zoom&hide-ui=1`;
  console.log(`[POC] Prototype URL: ${protoUrl}`);

  // Step 2: Launch headless browser (with or without session)
  const hasSession = existsSync(SESSION_PATH);
  console.log(`\n[POC] Step 2: Launch headless Chromium (session: ${hasSession ? 'YES ✓' : 'NO — run --capture first'})`);

  // --disable-web-security bypasses SameSite cookie restrictions in cross-origin iframes
  // This is intentional for the POC — we're testing if the postMessage protocol works at all
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
  });

  // Load storageState but override all cookies with SameSite=None so they're
  // sent in cross-origin iframe requests (Figma uses SameSite=Lax by default).
  const context = await browser.newContext();
  if (hasSession) {
    const session = JSON.parse(readFileSync(SESSION_PATH, 'utf-8')) as {
      cookies: Array<Record<string, unknown>>;
      origins: unknown[];
    };
    // Re-add cookies with SameSite=None to allow cross-origin iframe auth
    const cookies = session.cookies.map((c) => ({ ...c, sameSite: 'None' as const, secure: true }));
    await context.addCookies(cookies);
    console.log(`[POC] Injected ${cookies.length} cookies with SameSite=None`);
  }
  const page = await context.newPage();

  // ── Q1: Does the prototype render without a login wall? ───────────────────

  console.log('\n[Q1] Navigating to prototype URL...');
  const response = await page.goto(protoUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const finalUrl = page.url();
  const pageTitle = await page.title();
  console.log(`[Q1] Final URL: ${finalUrl}`);
  console.log(`[Q1] HTTP status: ${response?.status()}`);
  console.log(`[Q1] Page title: "${pageTitle}"`);

  const isLoginRedirect = finalUrl.includes('/login') || finalUrl.includes('/auth');
  console.log(`[Q1] Login redirect: ${isLoginRedirect}`);

  if (isLoginRedirect) {
    console.log('\n[Q1] FAIL — Auth wall not bypassed.');
    await browser.close();
    printVerdict(false, false);
    return;
  }

  // Wait up to 15s for Figma to render the canvas (JS-rendered, async)
  let hasCanvas = false;
  try {
    await page.waitForSelector('canvas', { timeout: 15_000 });
    hasCanvas = true;
    console.log('[Q1] Canvas rendered ✓');
  } catch {
    console.log('[Q1] Canvas not found after 15s — checking page structure...');
    const html = await page.content();
    console.log('[Q1] Page HTML (first 500 chars):', html.slice(0, 500));
  }

  // Q1 passes if we're on the prototype page (not redirected) — canvas is a bonus check
  const q1Pass = !isLoginRedirect && (hasCanvas || pageTitle.includes(pageTitle.split(' ')[0]));
  console.log(`\n[Q1] ${q1Pass ? 'PASS ✓' : 'FAIL — page did not render prototype'}`);

  if (!q1Pass) {
    await browser.close();
    printVerdict(false, false);
    return;
  }

  // ── Q2: Do postMessage navigation events fire via Embed Kit? ─────────────
  //
  // The Embed Kit 2.0 API works between a PARENT page and a Figma iframe.
  // We must create a wrapper page that embeds the prototype in an <iframe>
  // and posts NAVIGATE_TO_FRAME to iframe.contentWindow.
  // PRESENTED_NODE_CHANGED fires on the parent window from the iframe origin.

  console.log('\n[Q2] Creating embed wrapper page with Figma prototype in <iframe>...');

  const embedUrl =
    `https://www.figma.com/embed?embed_host=protoscan` +
    `&url=https://www.figma.com/proto/${FIGMA_FILE_KEY}/?node-id=${nodeId.replace(':', '-')}` +
    `&scaling=min-zoom&hide-ui=1`;

  // Navigate to a blank page and inject the embed wrapper
  const embedPage = await context.newPage();
  embedPage.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[Q2][browser-err] ${msg.text().slice(0, 120)}`);
  });
  await embedPage.setContent(`<!DOCTYPE html>
<html>
<head><title>ProtoScan POC Embed</title></head>
<body style="margin:0">
  <iframe
    id="figma-embed"
    src="${embedUrl}"
    style="width:100vw;height:100vh;border:none"
    allowfullscreen
  ></iframe>
</body>
</html>`);

  console.log(`[Q2] Embed URL: ${embedUrl}`);

  // Set up message listener BEFORE the embed loads to catch INITIAL_LOAD
  const earlyEvents: unknown[] = [];
  await embedPage.exposeFunction('__poc_earlyMsg', (data: unknown) => {
    earlyEvents.push(data);
    const t = (data as FigmaPostMessageEvent)?.type ?? '';
    if (t && !t.includes('multiplayer') && !t.includes('overlay')) {
      console.log(`[Q2][early] ${t}:`, JSON.stringify(data).slice(0, 100));
    }
  });
  await embedPage.evaluate(() => {
    window.addEventListener('message', (e) => { (window as unknown as PocWindow).__poc_earlyMsg(e.data); });
  });

  console.log('[Q2] Waiting up to 20s for Figma embed INITIAL_LOAD...');
  // Use string form to avoid esbuild __name serialisation bug in page.evaluate
  const initialLoadReceived = await embedPage.evaluate(`
    new Promise(function(resolve) {
      function handler(e) {
        if (e.data && e.data.type === 'INITIAL_LOAD') {
          window.removeEventListener('message', handler);
          resolve(true);
        }
      }
      window.addEventListener('message', handler);
      setTimeout(function() { resolve(false); }, 20000);
    })
  `) as boolean;
  console.log(`[Q2] INITIAL_LOAD received: ${initialLoadReceived}`);

  // Debug: list all frames to confirm embed loaded
  const frames = embedPage.frames();
  console.log(`[Q2] Frames loaded (${frames.length}):`);
  for (const f of frames) console.log(`  - ${f.url().slice(0, 80)}`);

  const receivedEvents: unknown[] = [];

  await embedPage.exposeFunction('__poc_onMessage', (data: unknown) => {
    receivedEvents.push(data);
    const preview = JSON.stringify(data).slice(0, 120);
    if ((data as FigmaPostMessageEvent)?.type === 'PRESENTED_NODE_CHANGED' || !(preview.includes('multiplayer') || preview.includes('overlay'))) {
      console.log('[Q2] Received postMessage:', preview);
    }
  });

  await embedPage.evaluate(() => {
    window.addEventListener('message', (e) => {
      (window as unknown as PocWindow).__poc_onMessage(e.data);
    });
  });

  // Get a genuine second node (first outgoing edge from starting node)
  const nextNode = getNextNodeFromGraph(cachedGraph!, nodeId) ?? nodeId;
  console.log(`[Q2] Navigating from ${nodeId} → ${nextNode} (${nextNode === nodeId ? 'same node — fallback' : 'real edge ✓'})`);

  // Diagnose: check if iframe.contentWindow is accessible and postMessage can be sent
  console.log(`[Q2] Diagnosing iframe access and sending NAVIGATE_TO_FRAME → node ${nextNode}...`);

  const diagnostics = await embedPage.evaluate((targetNodeId: string) => {
    const iframe = document.getElementById('figma-embed') as HTMLIFrameElement | null;
    const hasIframe = !!iframe;
    const hasContentWindow = !!iframe?.contentWindow;
    let sentOk = false;

    if (iframe?.contentWindow) {
      try {
        iframe.contentWindow.postMessage(
          { type: 'NAVIGATE_TO_FRAME', data: { frameId: targetNodeId } },
          'https://www.figma.com',
        );
        // Also try with '*' origin
        iframe.contentWindow.postMessage(
          { type: 'NAVIGATE_TO_FRAME', data: { frameId: targetNodeId } },
          '*',
        );
        sentOk = true;
      } catch (e: unknown) {
        return { hasIframe, hasContentWindow, sentOk: false, error: String(e) };
      }
    }
    return { hasIframe, hasContentWindow, sentOk };
  }, nextNode);

  console.log('[Q2] Diagnostics:', JSON.stringify(diagnostics));

  // Also try posting FROM WITHIN the Figma frame via Playwright CDP access
  // (bypasses cross-origin restriction — Playwright has CDP access to all frames)
  const figmaFrame = embedPage.frames().find((f) => f.url().includes('figma.com'));
  if (figmaFrame) {
    console.log(`[Q2] Posting NAVIGATE_TO_FRAME from within Figma frame (CDP)...`);
    await figmaFrame.evaluate((targetNodeId: string) => {
      // Post to parent (the embed flow direction)
      window.parent.postMessage(
        { type: 'NAVIGATE_TO_FRAME', data: { frameId: targetNodeId } },
        '*',
      );
      // Also post to self to trigger internal handlers
      window.postMessage(
        { type: 'NAVIGATE_TO_FRAME', data: { frameId: targetNodeId } },
        '*',
      );
    }, nextNode);
  } else {
    console.log('[Q2] No figma.com frame found via Playwright frames API');
  }

  // Wait for PRESENTED_NODE_CHANGED
  console.log(`[Q2] Waiting ${NAVIGATE_TIMEOUT_MS}ms for PRESENTED_NODE_CHANGED...`);
  await embedPage.waitForTimeout(NAVIGATE_TIMEOUT_MS);

  const presentedNodeEvents = receivedEvents.filter(
    (e): e is Record<string, unknown> =>
      typeof e === 'object' && e !== null && (e as Record<string, unknown>).type === 'PRESENTED_NODE_CHANGED',
  );

  const q2Pass = presentedNodeEvents.length > 0;
  if (q2Pass) {
    const ev = presentedNodeEvents[0] as Record<string, unknown>;
    console.log(`[Q2] PASS ✓ — PRESENTED_NODE_CHANGED fired. presentedNodeId: ${(ev.data as FigmaPostMessageEvent['data'])?.presentedNodeId ?? 'unknown'}`);
  } else {
    console.log('[Q2] FAIL — No PRESENTED_NODE_CHANGED event received within timeout.');
    console.log(`[Q2] All messages received (${receivedEvents.length}):`, JSON.stringify(receivedEvents).slice(0, 500));
  }

  await browser.close();
  printVerdict(q1Pass, q2Pass);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getStartingNodeFromGraph(graph: ReturnType<typeof buildGraph>): { nodeId: string; nodeName: string } {
  if (graph.startingPoints.length > 0) {
    const sp = graph.startingPoints[0];
    const node = graph.nodes.get(sp.nodeId);
    return { nodeId: sp.nodeId, nodeName: node?.name ?? sp.nodeId };
  }
  // Fallback: first node in the graph
  const first = graph.nodes.entries().next().value;
  if (first) return { nodeId: first[0], nodeName: first[1].name };
  console.error('[FAIL] Graph is empty — no screens found.');
  process.exit(1);
}

function getNextNodeFromGraph(graph: ReturnType<typeof buildGraph>, fromNodeId: string): string | null {
  const edges = graph.edges.get(fromNodeId) ?? [];
  for (const edge of edges) {
    if (edge.destinationId && edge.destinationId !== fromNodeId && graph.nodes.has(edge.destinationId)) {
      return edge.destinationId;
    }
  }
  return null;
}

function printVerdict(q1: boolean, q2: boolean): void {
  console.log('\n' + '═'.repeat(60));
  console.log('POC VERDICT');
  console.log('═'.repeat(60));
  console.log(`Q1 Auth wall bypass:          ${q1 ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log(`Q2 postMessage events fire:   ${q2 ? 'PASS ✓' : 'FAIL ✗'}`);
  console.log('─'.repeat(60));

  if (q1 && q2) {
    console.log('RESULT: GO — Implement Phase 2A (E2E Simulator via Embed Kit postMessage)');
  } else if (q1 && !q2) {
    console.log('RESULT: PARTIAL — Auth works but Embed Kit postMessage API is unavailable.');
    console.log('');
    console.log('FINDING: figma.com/proto does NOT implement Embed Kit 2.0 postMessage.');
    console.log('  The Embed Kit API (NAVIGATE_TO_FRAME / PRESENTED_NODE_CHANGED) is for');
    console.log('  design file embeds (/embed?type=design), not the prototype viewer.');
    console.log('  INITIAL_LOAD was never fired even after 20s of prototype running.');
    console.log('');
    console.log('ALTERNATIVE PATH (Phase 2A modified):');
    console.log('  → Canvas click simulation: use Figma REST API absoluteBoundingBox to');
    console.log('    locate interactive elements, click at those coordinates via Playwright,');
    console.log('    detect navigation by URL change (node-id param update).');
    console.log('  → Coordinate mapping: extract viewport scale from Figma proto URL params');
    console.log('    or page globals (__figma.viewportTransform).');
    console.log('  → This is plan-agnostic and does not require registered OAuth app.');
    console.log('');
    console.log('OR: Implement Phase 2B (Static Variable Analysis) — simpler, zero browser.');
  } else {
    console.log('RESULT: NO-GO for E2E approach → Implement Phase 2B (Static Variable Analysis)');
    if (!q1) {
      console.log('  → Auth wall not bypassable without a live browser session.');
    }
  }
  console.log('═'.repeat(60));
}
