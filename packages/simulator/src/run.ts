/**
 * Quick runner: walks a real project prototype and prints any runtime nav failures.
 * Usage: FIGMA_TOKEN=... npx tsx src/run.ts
 */
import { FigmaClient, buildGraph } from '@protoscan/core';
import { walkPrototype } from './walker.js';

const FILE_KEY = 'YOUR_FIGMA_FILE_KEY';
const TOKEN = process.env.FIGMA_TOKEN ?? '';

if (!TOKEN) { console.error('FIGMA_TOKEN required'); process.exit(1); }

console.log('[run] Fetching Figma file...');
const client = new FigmaClient(TOKEN);
const file = await client.getFile(FILE_KEY);
const graph = buildGraph(file);

console.log(`[run] Graph: ${graph.nodes.size} screens, ${graph.startingPoints.length} starting points`);

const issues = await walkPrototype(graph, { fileKey: FILE_KEY, maxScreens: 30, navTimeout: 8_000 });

if (issues.length === 0) {
  console.log('\n✅ No runtime navigation failures found.');
} else {
  console.log(`\n❌ Found ${issues.length} runtime navigation failure(s):\n`);
  for (const issue of issues) console.log(' •', issue.message);
}
