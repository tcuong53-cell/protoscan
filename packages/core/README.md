# @protoscan/core

Core analysis engine for ProtoScan — automated Figma prototype QA.

Parses Figma files via REST API, builds a directed graph of prototype connections, and runs 7 analyzers to detect navigation issues.

## Analyzers

- **Dead-end screens** — no outgoing connections
- **Orphan screens** — unreachable from any flow starting point
- **Missing back-nav** — screens without a way to go back
- **Small touch targets** — interactive elements under 44x44px
- **Overlapping hotspots** — multiple clickable elements in the same area
- **Missing scroll** — content overflows frame without scroll enabled
- **Overlay traps** — overlays with no close/back action

## Usage

```typescript
import { FigmaClient, scan, buildGraph, formatHtml, formatTerminal, formatJson } from '@protoscan/core';

const client = new FigmaClient(process.env.FIGMA_TOKEN!);
const file = await client.getFile('YOUR_FILE_KEY');
const result = await scan(file, { fileKey: 'YOUR_FILE_KEY' });

console.log(formatTerminal(result));
// Or: formatJson(result), formatHtml(result)
```

## Related packages

- [`@protoscan/cli`](https://www.npmjs.com/package/@protoscan/cli) — Command-line interface
- [`@protoscan/simulator`](https://www.npmjs.com/package/@protoscan/simulator) — E2E Playwright prototype walker
- [`@protoscan/mcp`](https://www.npmjs.com/package/@protoscan/mcp) — MCP server for Claude
- [GitHub](https://github.com/oxxo/protoscan)

## License

MIT
