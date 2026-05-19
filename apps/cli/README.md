# @protoscan/cli

Command-line interface for ProtoScan — automated Figma prototype QA.

```bash
npx @protoscan/cli scan YOUR_FILE_KEY
```

## Quick start

```bash
# Set your Figma token
export FIGMA_TOKEN=your_token_here

# Scan a prototype
npx @protoscan/cli scan YOUR_FIGMA_FILE_KEY

# HTML report
npx @protoscan/cli scan FILE_KEY --format html --output report.html

# Pass token inline
npx @protoscan/cli scan FILE_KEY --token figd_xxxx

# Full Figma URL
npx @protoscan/cli scan "https://www.figma.com/design/abc123/My-App?node-id=7-2"
```

## Options

```
protoscan scan <file-key-or-url>

  -t, --token <token>          Figma token (or set FIGMA_TOKEN env var)
  -f, --format <format>        terminal | json | html  (default: terminal)
  -o, --output <path>          Write output to file
  --min-touch-target <px>      Minimum touch target size (default: 44)
  --skip <checks>              Comma-separated checks to skip
  --pages <ids>                Comma-separated page IDs to scan
  --simulate                   Run Playwright E2E simulator
  --record [dir]               Record simulator walkthrough video (.webm)
  --upload                     Upload HTML report to GitHub Gist
  --vision                     Run GPT-4o vision analysis (requires OPENAI_API_KEY)
  --max-vision-cost <usd>      Max spend on vision analysis (default: 5)
```

## CI/CD

Exits with code 1 if critical or high issues are found.

## Related packages

- [`@protoscan/core`](https://www.npmjs.com/package/@protoscan/core) — Core analysis engine
- [`@protoscan/simulator`](https://www.npmjs.com/package/@protoscan/simulator) — E2E Playwright walker
- [`@protoscan/mcp`](https://www.npmjs.com/package/@protoscan/mcp) — MCP server for Claude
- [GitHub](https://github.com/oxxo/protoscan)

## License

MIT
