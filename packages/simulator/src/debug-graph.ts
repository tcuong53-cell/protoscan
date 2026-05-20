/**
 * Debug: dump graph edges + bounding boxes for key screens
 */
import { FigmaClient, buildGraph } from '@protoscan/core';

const FILE_KEY = process.env.FIGMA_FILE_KEY ?? '';
const TOKEN = process.env.FIGMA_TOKEN ?? '';
if (!TOKEN || !FILE_KEY) { console.error('FIGMA_TOKEN and FIGMA_FILE_KEY required'); process.exit(1); }

const client = new FigmaClient(TOKEN);
const file = await client.getFile(FILE_KEY);
const graph = buildGraph(file);

console.log(`Graph: ${graph.nodes.size} screens, ${graph.startingPoints.length} starting points\n`);

// Show payment flow starting point edges
for (const sp of graph.startingPoints) {
  console.log(`=== Flow: "${sp.name}" (${sp.nodeId}) ===`);
  const q = [sp.nodeId];
  const seen = new Set<string>();
  let count = 0;
  while (q.length && count < 10) {
    const id = q.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    count++;
    const node = graph.nodes.get(id);
    const bb = node?.boundingBox;
    const bbStr = bb ? `frame(${Math.round(bb.x)},${Math.round(bb.y)},${Math.round(bb.width)}x${Math.round(bb.height)})` : 'no-bb';
    console.log(`\n  [${count}] "${node?.name}" (${id}) ${bbStr}`);
    const edges = graph.edges.get(id) ?? [];
    for (const e of edges) {
      const destName = graph.nodes.get(e.destinationId)?.name ?? e.destinationId;
      const ebb = e.sourceElementBoundingBox;
      const ebbStr = ebb ? `elem(${Math.round(ebb.x)},${Math.round(ebb.y)},${Math.round(ebb.width)}x${Math.round(ebb.height)})` : 'no-bb';
      // Compute relative position within frame
      let relStr = '';
      if (ebb && bb) {
        const relX = Math.round(ebb.x - bb.x + ebb.width / 2);
        const relY = Math.round(ebb.y - bb.y + ebb.height / 2);
        relStr = ` rel(${relX},${relY})`;
      }
      console.log(`    → [${e.trigger}] ${e.navigation} → "${destName}" ${ebbStr}${relStr}`);
      q.push(e.destinationId);
    }
  }
  console.log('');
}
