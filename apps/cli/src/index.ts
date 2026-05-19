#!/usr/bin/env node
import { program } from 'commander';
import { FigmaClient, FigmaApiError, scan, formatJson, formatTerminal, formatHtml, buildGraph, type Issue } from '@protoscan/core';
import { writeFileSync, existsSync } from 'node:fs';

program
  .name('protoscan')
  .description('Automated Figma prototype QA — detect dead ends, orphan screens, and navigation issues.')
  .version('0.0.1')
  .addHelpText('after', `
Examples:
  protoscan scan YOUR_FILE_KEY
  protoscan scan "https://www.figma.com/design/abc123/My-App?node-id=7-2"
  protoscan scan FILE_KEY --format html --output report.html
  protoscan scan FILE_KEY --token figd_xxxx

First time? Set your Figma token:
  macOS/Linux:  export FIGMA_TOKEN=your_token_here
  PowerShell:   $env:FIGMA_TOKEN="your_token_here"
  Windows cmd:  set FIGMA_TOKEN=your_token_here

  Get your token at: https://www.figma.com/settings (Personal access tokens)
`);

program
  .command('scan')
  .description('Scan a Figma file for prototype issues')
  .argument('<file-key-or-url>', 'Figma file key or full URL (e.g., "abc123" or "https://figma.com/design/abc123/Name?node-id=7-2")')
  .option('-t, --token <token>', 'Figma Personal Access Token (or set FIGMA_TOKEN env var)')
  .option('-f, --format <format>', 'Output format: terminal, json, html', 'terminal')
  .option('-o, --output <path>', 'Output file path (for json/html formats)')
  .option('--min-touch-target <px>', 'Minimum touch target size in px', '44')
  .option('--skip <checks>', 'Comma-separated list of checks to skip')
  .option('--pages <ids>', 'Comma-separated page IDs to scan (default: all)')
  .option('--simulate', 'Run headless Playwright simulator to detect runtime nav failures (slow, requires @protoscan/simulator)')
  .option('--record [dir]', 'Record simulator walkthrough video (requires --simulate, saves .webm)')
  .option('--upload', 'Upload HTML report to GitHub Gist and return shareable URL (requires GITHUB_TOKEN)')
  .option('--vision', 'Run AI vision analysis on each screen with GPT-4o (requires OPENAI_API_KEY and @protoscan/vision)')
  .option('--max-vision-cost <usd>', 'Maximum USD to spend on vision analysis', '5')
  .action(async (input: string, options) => {
    // Parse Figma URL or raw file key
    const { fileKey, pageIds: urlPageIds } = parseFigmaInput(input);

    const token = options.token ?? process.env.FIGMA_TOKEN;
    if (!token) {
      console.error('Error: Figma token required.');
      console.error('');
      console.error('  macOS/Linux:  export FIGMA_TOKEN=your_token_here');
      console.error('  PowerShell:   $env:FIGMA_TOKEN="your_token_here"');
      console.error('  Windows cmd:  set FIGMA_TOKEN=your_token_here');
      console.error('  Or pass:      --token your_token_here');
      console.error('');
      console.error('  Get your token at: https://www.figma.com/settings (Personal access tokens)');
      process.exit(1);
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
      const graph = buildGraph(file, { pageIds: pageIds.length ? pageIds : undefined });

      let simulatorIssues: Issue[] = [];
      if (options.simulate) {
        try {
          const recordDir = options.record === true ? '.' : (options.record || undefined);
          if (recordDir) {
            console.error(`Recording walkthrough video to: ${recordDir}`);
          }
          console.error('Running simulator (this may take several minutes)...');
          const { walkPrototype } = await import('@protoscan/simulator');
          const walkResult = await walkPrototype(graph, { fileKey, recordDir });
          simulatorIssues = walkResult.issues;
          console.error(`Simulator: ${simulatorIssues.length} runtime issue(s) found.`);
          if (walkResult.videoPath) {
            console.error(`Recording saved: ${walkResult.videoPath}`);
          }
        } catch (err: unknown) {
          if (isModuleNotFound(err, '@protoscan/simulator')) {
            console.error('Error: --simulate requires @protoscan/simulator.');
            console.error('  npm install -g @protoscan/simulator');
            process.exit(1);
          }
          throw err;
        }
      } else if (options.record) {
        console.error('Warning: --record requires --simulate. Ignoring --record.');
      }

      let visionIssues: Issue[] = [];
      if (options.vision) {
        const openaiKey = process.env.OPENAI_API_KEY;
        if (!openaiKey) {
          console.error('Error: --vision requires OPENAI_API_KEY env var.');
          process.exit(1);
        }
        const screenCount = graph.nodes.size;
        const COST_PER_SCREEN = 0.005;
        const estimatedCost = (screenCount * COST_PER_SCREEN).toFixed(2);
        const maxCost = parseFloat(options.maxVisionCost);
        console.error('');
        console.error('⚠  Vision mode: screenshots of your Figma screens will be uploaded to OpenAI\'s API for analysis.');
        console.error('   Review OpenAI\'s data usage policy at https://openai.com/policies/api-data-usage-policies');
        console.error(`   Screens: ${screenCount} — estimated cost: ~$${estimatedCost} (cap: $${maxCost} via --max-vision-cost)`);
        console.error('');
        try {
          console.error('Running AI vision analysis (this may take a few minutes)...');
          const { analyzeVision } = await import('@protoscan/vision');
          visionIssues = await analyzeVision(graph, {
            figmaToken: token,
            openaiApiKey: openaiKey,
            fileKey,
            maxCost,
            maxScreens: 200,
          });
          console.error(`Vision: ${visionIssues.length} issue(s) found.`);
        } catch (err: unknown) {
          if (isModuleNotFound(err, '@protoscan/vision')) {
            console.error('Error: --vision is not available in this distribution.');
            console.error('   Contact support for access to ProtoScan Vision.');
            process.exit(1);
          }
          throw err;
        }
      }

      const result = await scan(file, {
        fileKey,
        minTouchTarget,
        skip: options.skip?.split(',').map((s: string) => s.trim()),
        pageIds: pageIds.length ? pageIds : undefined,
        additionalIssues: [...simulatorIssues, ...visionIssues],
      });

      const formatters: Record<string, (r: typeof result) => string> = {
        json: formatJson, html: formatHtml, terminal: formatTerminal,
      };
      const output = (formatters[options.format] ?? formatTerminal)(result);

      if (options.output) {
        if (existsSync(options.output)) {
          console.error(`Warning: overwriting existing file ${options.output}`);
        }
        writeFileSync(options.output, output, 'utf-8');
        console.error(`Report written to ${options.output}`);
      } else {
        console.log(output);
      }

      // Upload HTML report to GitHub Gist if requested
      if (options.upload) {
        const ghToken = process.env.GITHUB_TOKEN;
        if (!ghToken) {
          console.error('Error: --upload requires GITHUB_TOKEN env var with gist scope.');
          console.error('  Create one at: https://github.com/settings/tokens/new?scopes=gist');
        } else {
          const htmlOutput = formatHtml(result);
          const filename = `protoscan-${result.file.key}-${Date.now()}.html`;
          try {
            const gistRes = await fetch('https://api.github.com/gists', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${ghToken}`,
                'Content-Type': 'application/json',
                'User-Agent': 'protoscan-cli',
              },
              body: JSON.stringify({
                description: `ProtoScan Report — ${result.file.name}`,
                public: false,
                files: { [filename]: { content: htmlOutput } },
              }),
            });
            if (gistRes.ok) {
              const gist = await gistRes.json() as { html_url: string };
              console.error(`Report uploaded: ${gist.html_url}`);
            } else if (gistRes.status === 401) {
              console.error('Warning: Gist upload failed — GITHUB_TOKEN is invalid or expired.');
              console.error('  Generate a new one at: https://github.com/settings/tokens/new?scopes=gist');
            } else if (gistRes.status === 403) {
              console.error('Warning: Gist upload failed — GITHUB_TOKEN lacks the "gist" scope.');
              console.error('  Generate a new one at: https://github.com/settings/tokens/new?scopes=gist');
            } else {
              console.error(`Warning: Gist upload failed (HTTP ${gistRes.status})`);
            }
          } catch {
            console.error('Warning: Gist upload failed (network error)');
          }
        }
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

/** Returns true if the error is a module-not-found for the given package */
function isModuleNotFound(err: unknown, pkg: string): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as NodeJS.ErrnoException;
  return e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes(pkg);
}

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
