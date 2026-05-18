#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FigmaClient, FigmaApiError, scan, formatTerminal, formatJson } from '@protoscan/core';

const ScanArgsSchema = z.object({
  file_key: z.string().describe('Figma file key (from the URL, e.g. "abc123XYZ")'),
  token: z.string().optional().describe('Figma Personal Access Token. Falls back to FIGMA_TOKEN env var.'),
  format: z.enum(['terminal', 'json']).optional().default('terminal').describe('Output format'),
  min_touch_target: z.number().optional().default(44).describe('Minimum touch target size in px'),
  skip: z.array(z.string()).optional().describe('Checks to skip: dead-end, orphan, back-nav, touch-target, overlap, scroll, overlay-trap'),
});

const server = new Server(
  { name: 'protoscan', version: '0.0.1' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'scan_figma_prototype',
      description:
        'Scan a Figma file for prototype navigation issues: dead-end screens, orphan screens, missing back navigation, undersized touch targets, overlapping hotspots, missing scroll, and overlay traps. Returns a detailed report.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file_key: { type: 'string', description: 'Figma file key from the URL' },
          token: { type: 'string', description: 'Figma PAT (optional, falls back to FIGMA_TOKEN env var)' },
          format: { type: 'string', enum: ['terminal', 'json'], default: 'terminal' },
          min_touch_target: { type: 'number', default: 44, description: 'Min touch target px' },
          skip: { type: 'array', items: { type: 'string' }, description: 'Checks to skip' },
        },
        required: ['file_key'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'scan_figma_prototype') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const args = ScanArgsSchema.parse(request.params.arguments);
  const token = args.token || process.env.FIGMA_TOKEN;

  if (!token) {
    return {
      content: [{
        type: 'text' as const,
        text: 'Error: Figma token required. Pass it as "token" parameter or set FIGMA_TOKEN env var.',
      }],
      isError: true,
    };
  }

  try {
    const client = new FigmaClient(token);
    const file = await client.getFile(args.file_key);

    const result = await scan(file, {
      fileKey: args.file_key,
      minTouchTarget: args.min_touch_target,
      skip: args.skip,
    });

    const output = args.format === 'json'
      ? formatJson(result)
      : formatTerminal(result);

    return {
      content: [{ type: 'text' as const, text: output }],
    };
  } catch (error) {
    const message = error instanceof FigmaApiError
      ? error.message
      : error instanceof Error ? error.message : String(error);

    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ProtoScan MCP server started');
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
