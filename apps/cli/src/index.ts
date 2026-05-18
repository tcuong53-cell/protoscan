#!/usr/bin/env node
import { program } from 'commander';
import { FigmaClient, FigmaApiError, scan, formatJson, formatTerminal, formatHtml } from '@protoscan/core';
import { writeFileSync } from 'node:fs';

program
  .name('protoscan')
  .description('Automated Figma prototype QA — detect dead ends, orphan screens, and navigation issues.')
  .version('0.0.1');

program
  .command('scan')
  .description('Scan a Figma file for prototype issues')
  .argument('<file-key-or-url>', 'Figma file key or full URL (e.g., "abc123" or "https://figma.com/design/abc123/Name?node-id=7-2")')
  .option('-t, --token <token>', 'Figma personal access token (or set FIGMA_TOKEN env var)')
  .option('-f, --format <format>', 'Output format: terminal, json, html', 'terminal')
  .option('-o, --output <path>', 'Output file path (for json/html formats)')
  .option('--min-touch-target <px>', 'Minimum touch target size in px', '44')
  .option('--skip <checks>', 'Comma-separated list of checks to skip')
  .option('--pages <ids>', 'Comma-separated page IDs to scan (default: all)')
  .action(async (input: string, options) => {
    // Parse Figma URL or raw file key
    const { fileKey, pageIds: urlPageIds } = parseFigmaInput(input);

    const token = options.token || process.env.FIGMA_TOKEN;
    if (!token) {
      console.error('Error: Figma token required. Set FIGMA_TOKEN env var or use --token flag.');
      process.exit(1);
    }

    if (options.token) {
      console.error('Warning: Token passed via --token is visible in shell history. Prefer FIGMA_TOKEN env var.');
    }

    const minTouchTarget = parseInt(options.minTouchTarget, 10);
    if (isNaN(minTouchTarget) || minTouchTarget < 0) {
      console.error('Error: --min-touch-target must be a non-negative integer.');
      process.exit(1);
    }

    // Merge page IDs: explicit --pages flag takes priority, then URL node-id
    const pageIds = options.pages
      ? options.pages.split(',').map((s: string) => s.trim())
      : urlPageIds;

    try {
      console.error('Fetching Figma file...');
      const client = new FigmaClient(token);
      const file = await client.getFile(fileKey);
      console.error(`File: ${file.name}`);

      if (pageIds.length) {
        const pageNames = file.document.children
          ?.filter((p: { id: string }) => pageIds.includes(p.id))
          .map((p: { name: string }) => p.name) ?? [];
        console.error(`Scanning page${pageNames.length > 1 ? 's' : ''}: ${pageNames.join(', ') || pageIds.join(', ')}`);
      }

      console.error('Analyzing...');
      const result = await scan(file, {
        fileKey,
        minTouchTarget,
        skip: options.skip?.split(',').map((s: string) => s.trim()),
        pageIds: pageIds.length ? pageIds : undefined,
      });

      const formatters: Record<string, (r: typeof result) => string> = {
        json: formatJson, html: formatHtml, terminal: formatTerminal,
      };
      const output = (formatters[options.format] ?? formatTerminal)(result);

      if (options.output) {
        writeFileSync(options.output, output, 'utf-8');
        console.error(`Report written to ${options.output}`);
      } else {
        console.log(output);
      }

      const hasBlocking = result.summary.bySeverity.critical > 0 || result.summary.bySeverity.high > 0;
      process.exit(hasBlocking ? 1 : 0);
    } catch (error) {
      if (error instanceof FigmaApiError) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error('Unexpected error:', error instanceof Error ? error.message : error);
      }
      process.exit(1);
    }
  });

/** Parse a Figma URL or raw file key into fileKey + optional pageIds */
function parseFigmaInput(input: string): { fileKey: string; pageIds: string[] } {
  // Full URL: https://www.figma.com/design/YOUR_FIGMA_FILE_KEY/My-App?node-id=7-2
  const urlMatch = input.match(/figma\.com\/(?:design|file)\/([a-zA-Z0-9]+)/);
  if (urlMatch) {
    const fileKey = urlMatch[1];
    const nodeMatch = input.match(/node-id=([0-9]+-[0-9]+)/);
    const pageIds = nodeMatch ? [nodeMatch[1].replace('-', ':')] : [];
    return { fileKey, pageIds };
  }

  // Raw file key
  if (/^[a-zA-Z0-9]+$/.test(input)) {
    return { fileKey: input, pageIds: [] };
  }

  console.error('Error: Invalid input. Pass a Figma file key or URL.');
  process.exit(1);
}

program.parse();
