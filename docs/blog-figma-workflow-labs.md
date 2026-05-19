# The Missing Step in Figma's Code-to-Canvas Workflow: Automated Prototype QA

Figma just launched [Workflow Labs](https://www.figma.com/blog/) — a series of step-by-step guides for bringing AI into your design workflow. The first guide covers going from code to canvas using Figma's MCP server.

The workflow is:
1. Set up Figma MCP
2. Push prototypes to Figma
3. Review the product flow together
4. Send changes to code

It's a great workflow. But there's a missing step between 2 and 3.

## The problem nobody talks about

Before you share a prototype with your team, **how do you know it actually works?**

Every UX researcher and design agency owner has the same story:
- "A VP at our biggest client hit a dead end during a demo. He asked 'is this done?' and we lost the expansion deal."
- "I ran a $2,000 testing session and 2 of 5 participants hit dead ends. I had to throw out the data and re-recruit."

The current solution? Manually click through every path. For a 50-screen prototype, that's 2-8 hours of tedious work. And you'll still miss things.

## ProtoScan: Automated QA for Figma prototypes

[ProtoScan](https://github.com/oxxo/protoscan) scans your Figma file and detects prototype navigation issues in 30 seconds:

- **Dead-end screens** — screens with no way out
- **Orphan screens** — screens unreachable from any flow starting point
- **Missing back navigation** — screens you can navigate to but can't go back from
- **Small touch targets** — interactive elements under 44x44px
- **Overlapping hotspots** — two clickable elements in the same area
- **Missing scroll** — content extends beyond frame but scroll isn't enabled
- **Overlay traps** — overlays that block navigation permanently

## Add ProtoScan to the Figma Workflow Labs setup

If you already followed Figma's Workflow Labs guide and have the Figma MCP server configured, adding ProtoScan takes 30 seconds.

Add this to your MCP config alongside the Figma MCP server:

```json
{
  "mcpServers": {
    "figma": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-server-figma"],
      "env": { "FIGMA_API_KEY": "your_figma_token" }
    },
    "protoscan": {
      "command": "npx",
      "args": ["-y", "@protoscan/mcp"],
      "env": { "FIGMA_TOKEN": "your_figma_token" }
    }
  }
}
```

Now your workflow becomes:

1. Set up Figma MCP *(done)*
2. Push prototypes to Figma
3. **Ask Claude: "Scan this prototype for issues before I share it"** ← NEW
4. Review the product flow together *(with confidence)*
5. Send changes to code

## What it looks like

Tell Claude:

> "Scan my Figma prototype for issues: https://www.figma.com/design/abc123/My-App"

Claude calls ProtoScan, analyzes every screen and connection in your file, and returns a report with:
- Issue severity (critical, high, medium, low)
- Screen names and descriptions
- Direct links to open each issue in Figma

If your client supports MCP Apps (Claude Desktop, Claude.ai), you'll see an interactive HTML report rendered directly in the conversation — with severity filters and one-click Figma navigation.

## Or use the CLI

Don't use Claude? ProtoScan also works as a standalone CLI:

```bash
export FIGMA_TOKEN=your_token

# Quick scan
npx @protoscan/cli scan YOUR_FILE_KEY

# HTML report
npx @protoscan/cli scan YOUR_FILE_KEY --format html --output report.html

# Full Figma URL
npx @protoscan/cli scan "https://www.figma.com/design/abc123/My-App"
```

## Why this matters

A failed usability session costs $200-$400 per participant. A failed agency demo costs client trust. A broken prototype in a stakeholder review costs credibility.

Manual QA catches some of these issues — but it takes hours, and you'll always miss edge cases in a 50+ screen prototype.

ProtoScan catches them all in 30 seconds, every time, automatically.

## Get started

- **GitHub:** [github.com/oxxo/protoscan](https://github.com/oxxo/protoscan)
- **npm:** `npx @protoscan/cli scan YOUR_FILE_KEY`
- **MCP:** `npx @protoscan/mcp` (add to Claude Desktop)
- **Smithery:** [smithery.ai/servers/oxxo/protoscan](https://smithery.ai/servers/oxxo/protoscan)

Star the repo if this is useful. ProtoScan is open-source (MIT) and free for all static analysis. AI vision analysis and video recording coming soon in Pro.

---

*ProtoScan is the first automated prototype QA tool. It's open-source, built with TypeScript, and works with any Figma file. No Figma plugin needed — just your API token.*
