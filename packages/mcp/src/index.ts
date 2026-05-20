#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { FigmaClient, FigmaApiError, scan, buildGraph, formatTerminal, formatJson, formatHtml } from '@protoscan/core';
import type { Issue } from '@protoscan/core';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';

function parseFigmaInput(input: string): { fileKey: string; pageIds: string[] } {
  const urlMatch = input.match(/figma\.com\/(?:design|file|proto)\/([a-zA-Z0-9]+)/);
  if (urlMatch) {
    const fileKey = urlMatch[1];
    const nodeMatch = input.match(/node-id=([0-9]+-[0-9]+)/);
    const pageIds = nodeMatch ? [nodeMatch[1].replace('-', ':')] : [];
    return { fileKey, pageIds };
  }
  // Bare file key — validate format
  if (!/^[a-zA-Z0-9]+$/.test(input)) {
    throw new Error(`Invalid Figma file key: "${input}". Expected alphanumeric key or full Figma URL.`);
  }
  return { fileKey: input, pageIds: [] };
}

const server = new McpServer(
  { name: 'protoscan', version: '0.0.1' },
  { capabilities: { resources: {} } },
);

// Store the latest HTML report for the UI resource to serve.
// Safe for stdio (single client). For remote/multi-client use, this would need
// per-session state (e.g., keyed by request ID or session token).
let latestReportHtml = '<html><body><p>Run a scan first.</p></body></html>';

// Register the UI resource that serves the interactive HTML report
registerAppResource(
  server,
  'ProtoScan Report',
  'ui://protoscan/report',
  {
    description: 'Interactive ProtoScan scan report with severity filters and Figma deep links',
  },
  async () => ({
    contents: [
      {
        uri: 'ui://protoscan/report',
        mimeType: RESOURCE_MIME_TYPE,
        text: latestReportHtml,
      },
    ],
  }),
);

// Register the scan tool with MCP Apps UI
registerAppTool(
  server,
  'scan_figma_prototype',
  {
    title: 'Scan Figma Prototype',
    description:
      'Scan a Figma file for prototype navigation issues: dead-end screens, orphan screens, missing back navigation, undersized touch targets, overlapping hotspots, missing scroll, and overlay traps. Optionally run a headless browser simulator to verify clicks actually navigate. Returns a detailed report. If the client supports MCP Apps, renders an interactive HTML report inline.',
    inputSchema: {
      file_key: z.string().describe('Figma file key or full URL (e.g. "abc123" or "https://figma.com/design/abc123/Name?node-id=7-2")'),
      token: z.string().optional().describe('Figma Personal Access Token. Falls back to FIGMA_TOKEN env var.'),
      simulate: z.boolean().optional().default(false).describe('Run headless browser simulator to verify prototype navigation actually works. Slower (~2 min) but catches runtime issues static analysis misses.'),
      format: z.enum(['terminal', 'json']).optional().default('terminal').describe('Output format for text response'),
      min_touch_target: z.number().optional().default(44).describe('Minimum touch target size in px'),
      skip: z.array(z.string()).optional().describe('Checks to skip: dead-end, orphan, back-nav, touch-target, overlap, scroll, overlay-trap'),
    },
    _meta: {
      ui: { resourceUri: 'ui://protoscan/report' },
    },
  },
  async (args) => {
    const token = args.token || process.env.FIGMA_TOKEN;

    if (!token) {
      return {
        content: [{
          type: 'text' as const,
          text: 'Error: Figma token required. Pass it as "token" parameter or set FIGMA_TOKEN env var.',
        }],
      };
    }

    try {
      const { fileKey, pageIds } = parseFigmaInput(args.file_key);
      const client = new FigmaClient(token);
      const file = await client.getFile(fileKey);

      // Run simulator if requested (Pro feature — requires PROTOSCAN_API_KEY)
      let simulatorIssues: Issue[] = [];
      let videoPath: string | undefined;
      if (args.simulate) {
        const proKey = process.env.PROTOSCAN_API_KEY;
        if (!proKey) {
          console.error('[protoscan] simulate requires PROTOSCAN_API_KEY — skipping, running static analysis only');
        } else {
          try {
            const { walkPrototype } = await import('@protoscan/simulator');
            const graph = buildGraph(file, {
              pageIds: pageIds.length ? pageIds : undefined,
            });
            console.error('[protoscan] Running simulator (this may take several minutes)...');
            const walkResult = await walkPrototype(graph, { fileKey, maxScreens: 30 });
            simulatorIssues = walkResult.issues;
            videoPath = walkResult.videoPath;
            console.error(`[protoscan] Simulator: ${simulatorIssues.length} runtime issue(s)`);
          } catch (simError) {
            const msg = simError instanceof Error ? simError.message : String(simError);
            console.error(`[protoscan] Simulator error: ${msg}`);
          }
        }
      }

      const result = await scan(file, {
        fileKey,
        minTouchTarget: args.min_touch_target,
        skip: args.skip,
        pageIds: pageIds.length ? pageIds : undefined,
        additionalIssues: simulatorIssues.length ? simulatorIssues : undefined,
      });

      // Update the HTML report for the MCP Apps UI resource
      latestReportHtml = formatHtml(result);

      const output = args.format === 'json'
        ? formatJson(result)
        : formatTerminal(result);

      const content: Array<{ type: 'text'; text: string }> = [
        { type: 'text' as const, text: output },
      ];
      if (videoPath) {
        content.push({ type: 'text' as const, text: `\n🎥 Video walkthrough saved: ${videoPath}` });
      }

      return { content };
    } catch (error) {
      const message = error instanceof FigmaApiError
        ? error.message
        : error instanceof Error ? error.message : String(error);

      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ProtoScan MCP server started');
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
