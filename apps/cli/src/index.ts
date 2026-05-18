#!/usr/bin/env node
import { program } from 'commander';
import { FigmaClient, FigmaApiError, scan, formatJson, formatTerminal } from '@protoscan/core';
import { writeFileSync } from 'node:fs';

program
  .name('protoscan')
  .description('Automated Figma prototype QA — detect dead ends, orphan screens, and navigation issues.')
  .version('0.0.1');

program
  .command('scan')
  .description('Scan a Figma file for prototype issues')
  .argument('<file-key>', 'Figma file key (from the URL)')
  .option('-t, --token <token>', 'Figma personal access token (or set FIGMA_TOKEN env var)')
  .option('-f, --format <format>', 'Output format: terminal, json', 'terminal')
  .option('-o, --output <path>', 'Output file path (for json/html formats)')
  .option('--min-touch-target <px>', 'Minimum touch target size in px', '44')
  .option('--skip <checks>', 'Comma-separated list of checks to skip')
  .action(async (fileKey: string, options) => {
    // Validate file key — must be alphanumeric (Figma file keys are)
    if (!/^[a-zA-Z0-9]+$/.test(fileKey)) {
      console.error('Error: Invalid file key. Figma file keys are alphanumeric (e.g., "abc123XYZ").');
      process.exit(1);
    }

    const token = options.token || process.env.FIGMA_TOKEN;
    if (!token) {
      console.error('Error: Figma token required. Set FIGMA_TOKEN env var or use --token flag.');
      process.exit(1);
    }

    // Warn about token in process args
    if (options.token) {
      console.error('Warning: Token passed via --token is visible in process listings and shell history. Prefer FIGMA_TOKEN env var.');
    }

    // Validate min-touch-target
    const minTouchTarget = parseInt(options.minTouchTarget, 10);
    if (isNaN(minTouchTarget) || minTouchTarget < 0) {
      console.error('Error: --min-touch-target must be a non-negative integer.');
      process.exit(1);
    }

    try {
      // Fetch file
      console.error('Fetching Figma file...');
      const client = new FigmaClient(token);
      const file = await client.getFile(fileKey);
      console.error(`File: ${file.name}`);

      // Run scan
      console.error('Analyzing...');
      const result = await scan(file, {
        fileKey,
        minTouchTarget,
        skip: options.skip?.split(',').map((s: string) => s.trim()),
      });

      // Format output
      const output =
        options.format === 'json' ? formatJson(result) : formatTerminal(result);

      // Write output
      if (options.output) {
        writeFileSync(options.output, output, 'utf-8');
        console.error(`Report written to ${options.output}`);
      } else {
        console.log(output);
      }

      // Exit code based on severity
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

program.parse();
