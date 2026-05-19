/**
 * AI Vision analyzer — fetches Figma screen renders and analyzes them with GPT-4o Vision.
 *
 * Cost model (GPT-4o, May 2026):
 *   ~$0.00255 per image (1024x1024 detail:low) + ~$0.002 per response
 *   → ~$0.005 per screen → $0.50 per 100 screens
 */

import OpenAI from 'openai';
import type { Issue, PrototypeGraph } from '@protoscan/core';
import { SYSTEM_PROMPT, type VisionFinding } from './prompts.js';

const FIGMA_API_BASE = 'https://api.figma.com';
const IMAGES_BATCH = 50; // Figma images API max per request
const COST_PER_SCREEN = 0.005;

// Retry config
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 5_000; // 5s initial backoff

export interface VisionOptions {
  figmaToken: string;
  openaiApiKey: string;
  fileKey: string;
  /** Max USD to spend. Stops after budget is reached. Default: 5 */
  maxCost?: number;
  /** Max screens to analyze. Default: 200 */
  maxScreens?: number;
}

/** Sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry with exponential backoff on rate limit (429) or transient errors */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  onRetry?: (attempt: number, delayMs: number) => void,
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        err instanceof Error &&
        (err.message.includes('429') ||
          err.message.includes('Rate limit') ||
          err.message.includes('fetch failed') ||
          err.message.includes('ECONNRESET') ||
          err.message.includes('503'));

      if (!isRetryable || attempt === MAX_RETRIES) throw err;

      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt); // 5s, 10s, 20s
      onRetry?.(attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
  throw new Error(`${label}: max retries exceeded`);
}

/** Format elapsed time */
function formatTime(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

/** Fetch PNG render URLs from Figma for a batch of node IDs */
async function fetchImageUrls(
  figmaToken: string,
  fileKey: string,
  nodeIds: string[],
): Promise<Map<string, string>> {
  const ids = nodeIds.join(',');
  const url = `${FIGMA_API_BASE}/v1/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=png&scale=1`;

  const response = await fetch(url, {
    headers: { 'X-Figma-Token': figmaToken },
  });

  if (!response.ok) {
    throw new Error(`Figma images API returned ${response.status}`);
  }

  const data = await response.json() as { images: Record<string, string | null> };
  const map = new Map<string, string>();
  for (const [id, imgUrl] of Object.entries(data.images)) {
    if (imgUrl) map.set(id, imgUrl);
  }
  return map;
}

/** Fetch image as base64 */
async function fetchBase64(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

/** Analyze a single screen image with GPT-4o Vision */
async function analyzeScreen(
  openai: OpenAI,
  base64Image: string,
  screenName: string,
): Promise<VisionFinding[]> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 500,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Screen name: "${screenName}"\n\nAnalyze this prototype screen for UX issues:`,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${base64Image}`,
              detail: 'low',
            },
          },
        ],
      },
    ],
  });

  const content = response.choices[0]?.message?.content ?? '[]';
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed as VisionFinding[];
  } catch {
    return [];
  }
}

/**
 * Run AI vision analysis on all screens in the prototype graph.
 * Returns Issue[] compatible with @protoscan/core scan pipeline.
 */
export async function analyzeVision(
  graph: PrototypeGraph,
  options: VisionOptions,
): Promise<Issue[]> {
  const {
    figmaToken,
    openaiApiKey,
    fileKey,
    maxCost = 5,
    maxScreens = 200,
  } = options;

  const openai = new OpenAI({ apiKey: openaiApiKey });

  const screenIds = [...graph.nodes.values()]
    .filter((n) => n.boundingBox)
    .slice(0, maxScreens)
    .map((n) => n.id);

  const total = screenIds.length;
  const startTime = Date.now();
  console.error(`[vision] Analyzing ${total} screens...`);

  // Fetch image URLs in batches
  const imageUrlMap = new Map<string, string>();
  for (let i = 0; i < screenIds.length; i += IMAGES_BATCH) {
    const batch = screenIds.slice(i, i + IMAGES_BATCH);
    const urls = await fetchImageUrls(figmaToken, fileKey, batch);
    for (const [id, url] of urls) imageUrlMap.set(id, url);
    if (i + IMAGES_BATCH < screenIds.length) await sleep(1000);
  }

  const issues: Issue[] = [];
  let issueCounter = 0;
  let totalCost = 0;
  let analyzed = 0;

  for (const nodeId of screenIds) {
    if (totalCost >= maxCost) {
      console.error(`[vision] Cost limit $${maxCost} reached after ${analyzed}/${total} screens.`);
      break;
    }

    const imgUrl = imageUrlMap.get(nodeId);
    if (!imgUrl) continue;

    const node = graph.nodes.get(nodeId)!;
    analyzed++;

    try {
      const findings = await withRetry(
        async () => {
          const base64 = await fetchBase64(imgUrl);
          return analyzeScreen(openai, base64, node.name);
        },
        node.name,
        (attempt, delayMs) => {
          console.error(`[vision]   ⏳ "${node.name}" rate limited, retry ${attempt}/${MAX_RETRIES} in ${delayMs / 1000}s...`);
        },
      );
      totalCost += COST_PER_SCREEN;

      for (const f of findings) {
        issues.push({
          id: `vision-${++issueCounter}`,
          category: 'vision',
          severity: f.severity,
          confidence: 'probable',
          screenId: nodeId,
          screenName: node.name,
          nodeId,
          message: f.message,
          evidence: { visionCategory: f.category, area: f.area, model: 'gpt-4o' },
        });
      }

      const elapsed = formatTime(Date.now() - startTime);
      const rate = analyzed / ((Date.now() - startTime) / 1000);
      const eta = rate > 0 ? formatTime(((total - analyzed) / rate) * 1000) : '?';
      const issueStr = findings.length > 0 ? ` → ${findings.length} issue(s)` : '';
      console.error(`[vision] [${analyzed}/${total}] ${node.name}${issueStr} (${elapsed} elapsed, ~${eta} remaining)`);
    } catch (err) {
      console.error(`[vision]   ⚠ Skipped "${node.name}" after ${MAX_RETRIES} retries: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.error(`[vision] Done. ${issues.length} issues found. Cost: ~$${totalCost.toFixed(2)}`);
  return issues;
}

// --- Proxy mode: calls ProtoScan server-side vision API instead of OpenAI directly ---

export interface VisionProxyOptions {
  protoscanApiKey: string;
  figmaToken: string;
  fileKey: string;
  /** Max USD to spend. Stops after budget is reached. Default: 5 */
  maxCost?: number;
  /** Max screens to analyze. Default: 200 */
  maxScreens?: number;
  /** Vision proxy URL. Default: https://web-five-beige-24.vercel.app/api/vision */
  proxyUrl?: string;
}

/**
 * Run AI vision analysis via ProtoScan's server-side proxy.
 * The user doesn't need an OpenAI key — ProtoScan's key is used server-side.
 * Includes retry with exponential backoff for rate limits.
 */
export async function analyzeVisionProxy(
  graph: PrototypeGraph,
  options: VisionProxyOptions,
): Promise<Issue[]> {
  const {
    protoscanApiKey,
    figmaToken,
    fileKey,
    maxCost = 5,
    maxScreens = 200,
    proxyUrl = 'https://web-five-beige-24.vercel.app/api/vision',
  } = options;

  const screenIds = [...graph.nodes.values()]
    .filter((n) => n.boundingBox)
    .slice(0, maxScreens)
    .map((n) => n.id);

  const total = screenIds.length;
  const startTime = Date.now();
  console.error(`[vision-proxy] Analyzing ${total} screens via ProtoScan API...`);

  // Fetch image URLs in batches
  const imageUrlMap = new Map<string, string>();
  for (let i = 0; i < screenIds.length; i += IMAGES_BATCH) {
    const batch = screenIds.slice(i, i + IMAGES_BATCH);
    const urls = await fetchImageUrls(figmaToken, fileKey, batch);
    for (const [id, url] of urls) imageUrlMap.set(id, url);
    if (i + IMAGES_BATCH < screenIds.length) await sleep(1000);
  }

  const issues: Issue[] = [];
  let issueCounter = 0;
  let totalCost = 0;
  let analyzed = 0;

  for (const nodeId of screenIds) {
    if (totalCost >= maxCost) {
      console.error(`[vision-proxy] Cost limit $${maxCost} reached after ${analyzed}/${total} screens.`);
      break;
    }

    const imgUrl = imageUrlMap.get(nodeId);
    if (!imgUrl) continue;

    const node = graph.nodes.get(nodeId)!;
    analyzed++;

    try {
      const data = await withRetry(
        async () => {
          const base64 = await fetchBase64(imgUrl);
          const response = await fetch(proxyUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${protoscanApiKey}`,
            },
            body: JSON.stringify({ image: base64, screenName: node.name }),
          });

          if (!response.ok) {
            const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as { error?: string };
            if (response.status === 402) {
              throw new Error('NO_CREDITS');
            }
            throw new Error(err.error ?? `Proxy returned ${response.status}`);
          }

          return response.json() as Promise<{ findings: VisionFinding[] }>;
        },
        node.name,
        (attempt, delayMs) => {
          console.error(`[vision-proxy]   ⏳ "${node.name}" rate limited, retry ${attempt}/${MAX_RETRIES} in ${delayMs / 1000}s...`);
        },
      );

      // Check for credit exhaustion (non-retryable)
      totalCost += COST_PER_SCREEN;

      for (const f of data.findings) {
        issues.push({
          id: `vision-${++issueCounter}`,
          category: 'vision',
          severity: f.severity,
          confidence: 'probable',
          screenId: nodeId,
          screenName: node.name,
          nodeId,
          message: f.message,
          evidence: { visionCategory: f.category, area: f.area, model: 'gpt-4o', via: 'proxy' },
        });
      }

      const elapsed = formatTime(Date.now() - startTime);
      const rate = analyzed / ((Date.now() - startTime) / 1000);
      const eta = rate > 0 ? formatTime(((total - analyzed) / rate) * 1000) : '?';
      const issueStr = data.findings.length > 0 ? ` → ${data.findings.length} issue(s)` : '';
      console.error(`[vision-proxy] [${analyzed}/${total}] ${node.name}${issueStr} (${elapsed} elapsed, ~${eta} remaining)`);
    } catch (err) {
      if (err instanceof Error && err.message === 'NO_CREDITS') {
        console.error(`[vision-proxy] No credits remaining. Purchase more at https://protoscan.dev/pricing`);
        break;
      }
      console.error(`[vision-proxy]   ⚠ Skipped "${node.name}" after ${MAX_RETRIES} retries: ${err instanceof Error ? err.message : err}`);
    }
  }

  const elapsed = formatTime(Date.now() - startTime);
  console.error(`[vision-proxy] Done. ${issues.length} issues in ${analyzed}/${total} screens. Cost: ~$${totalCost.toFixed(2)} (${elapsed})`);
  return issues;
}
