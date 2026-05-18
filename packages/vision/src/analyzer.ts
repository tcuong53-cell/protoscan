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

export interface VisionOptions {
  figmaToken: string;
  openaiApiKey: string;
  fileKey: string;
  /** Max USD to spend. Stops after budget is reached. Default: 5 */
  maxCost?: number;
  /** Max screens to analyze. Default: 200 */
  maxScreens?: number;
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
              detail: 'low', // cheaper, sufficient for layout/contrast analysis
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

  // Collect screen node IDs (only screens with bounding boxes — real prototype frames)
  const screenIds = [...graph.nodes.values()]
    .filter((n) => n.boundingBox)
    .slice(0, maxScreens)
    .map((n) => n.id);

  console.error(`[vision] Analyzing ${screenIds.length} screens...`);

  // Fetch image URLs in batches of 50
  const imageUrlMap = new Map<string, string>();
  for (let i = 0; i < screenIds.length; i += IMAGES_BATCH) {
    const batch = screenIds.slice(i, i + IMAGES_BATCH);
    const urls = await fetchImageUrls(figmaToken, fileKey, batch);
    for (const [id, url] of urls) imageUrlMap.set(id, url);
    // Small delay to avoid Figma rate limits
    if (i + IMAGES_BATCH < screenIds.length) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const issues: Issue[] = [];
  let issueCounter = 0;
  let totalCost = 0;
  const COST_PER_SCREEN = 0.005; // conservative estimate

  for (const nodeId of screenIds) {
    if (totalCost >= maxCost) {
      console.error(`[vision] Cost limit $${maxCost} reached — analyzed ${issueCounter} screens.`);
      break;
    }

    const imgUrl = imageUrlMap.get(nodeId);
    if (!imgUrl) continue;

    const node = graph.nodes.get(nodeId)!;

    try {
      const base64 = await fetchBase64(imgUrl);
      const findings = await analyzeScreen(openai, base64, node.name);
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
          evidence: {
            visionCategory: f.category,
            area: f.area,
            model: 'gpt-4o',
          },
        });
      }

      if (findings.length > 0) {
        console.error(`[vision]   ${node.name}: ${findings.length} issue(s)`);
      }
    } catch (err) {
      console.error(`[vision]   ⚠ Skipped "${node.name}": ${err instanceof Error ? err.message : err}`);
    }
  }

  console.error(`[vision] Done. ${issues.length} issues found. Estimated cost: $${totalCost.toFixed(2)}`);
  return issues;
}
