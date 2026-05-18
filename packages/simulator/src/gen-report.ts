/**
 * One-shot: runs simulator + static analysis + generates HTML report.
 * Usage: FIGMA_TOKEN=... npx tsx src/gen-report.ts
 */
import { FigmaClient, buildGraph, scan, formatHtml } from '@protoscan/core';
import { walkPrototype } from './walker.js';
import { writeFileSync } from 'node:fs';

const FILE_KEY = process.env.FIGMA_FILE_KEY ?? 'YOUR_FILE_KEY';
const TOKEN = process.env.FIGMA_TOKEN ?? '';
if (!TOKEN) { console.error('FIGMA_TOKEN required'); process.exit(1); }

console.log('[gen-report] Fetching Figma file...');
const client = new FigmaClient(TOKEN);
const file = await client.getFile(FILE_KEY);
const graph = buildGraph(file);
console.log(`[gen-report] Graph: ${graph.nodes.size} screens, ${graph.startingPoints.length} starting points`);

console.log('[gen-report] Running simulator...');
const simIssues = await walkPrototype(graph, { fileKey: FILE_KEY, maxScreens: 30, navTimeout: 8_000 });
console.log(`[gen-report] Simulator: ${simIssues.length} runtime issues`);

console.log('[gen-report] Running static analysis...');
const result = await scan(file, { fileKey: FILE_KEY, additionalIssues: simIssues });

const html = formatHtml(result);
writeFileSync('report.html', html);
console.log(`[gen-report] Done. Total issues: ${result.summary.total} (runtime: ${result.summary.byCategory['runtime-nav-failure'] ?? 0})`);
