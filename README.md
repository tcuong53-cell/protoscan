# ProtoScan

**Automated QA for Figma prototypes.** Catch dead ends, broken navigation, and UX issues before your next usability test or stakeholder demo.

```
npx @protoscan/cli scan YOUR_FILE_KEY
```

---

## What it detects

| Category | How | Description |
|---|---|---|
| Dead-end screens | Static | Screens with no way out (no back, no close, no links) |
| Orphan screens | Static | Screens unreachable from any flow starting point |
| Missing back-nav | Static | Screens inside flows with no way to go back |
| Small touch targets | Static | Interactive elements under 44×44px |
| Overlapping hotspots | Static | Two clickable elements occupying the same area |
| Missing scroll | Static | Content extends beyond frame but scroll is not enabled |
| Overlay traps | Static | Overlays that block navigation permanently |
| Runtime nav failures | E2E | Clicks that don't navigate, or navigate to the wrong screen |
| Visual UX issues | AI Vision | Contrast, clarity, empty states, information overload |

---

## Quickstart

```bash
# Set your Figma token (get one at figma.com → Settings → Personal access tokens)
# macOS/Linux:
export FIGMA_TOKEN=your_token_here
# PowerShell:
$env:FIGMA_TOKEN="your_token_here"
# Windows cmd:
set FIGMA_TOKEN=your_token_here

# Scan a file
npx @protoscan/cli scan YOUR_FIGMA_FILE_KEY

# Generate an HTML report
npx @protoscan/cli scan YOUR_FIGMA_FILE_KEY --format html --output report.html

# Pass token inline (alternative to env var)
npx @protoscan/cli scan YOUR_FIGMA_FILE_KEY --token figd_xxxx

# Use a full Figma URL (filters to the page in the URL)
npx @protoscan/cli scan "https://www.figma.com/design/YOUR_FIGMA_FILE_KEY/My-App?node-id=7-2"
```

---

## Options

```
protoscan scan <file-key-or-url>

Options:
  -t, --token <token>          Figma token (or set FIGMA_TOKEN env var)
  -f, --format <format>        terminal | json | html  (default: terminal)
  -o, --output <path>          Write output to file
  --min-touch-target <px>      Minimum touch target size (default: 44)
  --skip <checks>              Comma-separated checks to skip
  --pages <ids>                Comma-separated page IDs to scan
  --simulate                   Run Playwright E2E simulator (slow, finds runtime bugs)
  --record [dir]               Record simulator walkthrough video (requires --simulate)
  --upload                     Upload HTML report to GitHub Gist (requires GITHUB_TOKEN)
  --vision                     Run GPT-4o vision analysis (requires OPENAI_API_KEY)
  --max-vision-cost <usd>      Max spend on vision analysis (default: 5)
```

---

## E2E Simulator

The `--simulate` flag launches a headless Chromium browser, loads every screen of your prototype, and clicks each interactive element — verifying that navigation actually works at runtime.

This catches bugs that static analysis can't see:
- Variable-gated dead ends (conditional branches that always take one path)
- Interactions that are wired in the JSON but silently broken in the prototype viewer

```bash
# Requires a Figma session file for auth (captured via playwright)
npx @protoscan/cli scan FILE_KEY --simulate --format html --output report.html
```

---

## AI Vision

The `--vision` flag renders every screen via the Figma images API and analyzes each one with GPT-4o Vision, looking for visual UX problems invisible in the JSON:

- **vision-contrast** — text on low-contrast backgrounds
- **vision-clarity** — ambiguous CTAs, unclear visual hierarchy
- **vision-empty-state** — screens that appear broken or incomplete
- **vision-overload** — too many competing elements

```bash
export OPENAI_API_KEY=your_openai_key

npx @protoscan/cli scan FILE_KEY --vision --max-vision-cost 2
# ~$0.005 per screen, ~$0.50 per 100 screens with GPT-4o
```

---

## CI/CD Integration

ProtoScan exits with code `1` if critical or high issues are found:

```yaml
# GitHub Actions example
- name: Scan Figma prototype
  env:
    FIGMA_TOKEN: ${{ secrets.FIGMA_TOKEN }}
  run: npx @protoscan/cli scan ${{ vars.FIGMA_FILE_KEY }} --format json --output scan.json
```

---

## Architecture

```
protoscan/
  packages/
    core/        @protoscan/core   (MIT) — graph + spatial analyzers, reporters
    simulator/   @protoscan/simulator  (MIT) — Playwright BFS walker
    vision/      @protoscan/vision  (Proprietary) — GPT-4o vision analysis
  apps/
    cli/         @protoscan/cli   (MIT) — CLI entry point
```

**Open-core model:**
- `@protoscan/core`, `@protoscan/cli`, `@protoscan/simulator` — MIT, free forever
- `@protoscan/vision` — Proprietary

---

## Pro

**ProtoScan Pro** adds server-side AI vision analysis, video recording of prototype walkthroughs, and shareable report URLs — without needing your own OpenAI API key.

| Feature | Free | Pro ($29/mo) |
|---------|:----:|:----:|
| 7 static analyzers (dead-end, orphan, back-nav, touch target, overlap, scroll, overlay trap) | Unlimited | Unlimited |
| E2E Playwright simulator (`--simulate`) | Unlimited | Unlimited |
| HTML/JSON/terminal reports | Unlimited | Unlimited |
| MCP server for Claude | Unlimited | Unlimited |
| AI vision analysis (`--vision`) | BYOK (your OpenAI key) | Server-side (no key needed) |
| Video recording (`--simulate --record`) | — | Included |
| Shareable report URL (`--upload`) | — | Included |
| AI fix suggestions per issue | — | Included |

Coming soon. [Star the repo](https://github.com/oxxo/protoscan) to get notified.

---

## License

MIT — see [LICENSE](LICENSE) for `@protoscan/core`, `@protoscan/cli`, `@protoscan/simulator`.  
`@protoscan/vision` is proprietary.
