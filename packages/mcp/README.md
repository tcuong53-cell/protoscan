# @protoscan/mcp

MCP server for ProtoScan — expose Figma prototype QA as a tool for Claude and other MCP clients.

Gives Claude (and any MCP-compatible client) a `scan_figma_prototype` tool that detects dead-end screens, orphan screens, broken back-navigation, small touch targets, overlapping hotspots, missing scroll, and overlay traps in any Figma prototype.

## Setup with Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "protoscan": {
      "command": "npx",
      "args": ["-y", "@protoscan/mcp"],
      "env": {
        "FIGMA_TOKEN": "your_figma_token_here"
      }
    }
  }
}
```

Config file location:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Get your Figma token at: **https://www.figma.com/settings** → Personal access tokens

## Tool: `scan_figma_prototype`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_key` | string | Yes | Figma file key or full URL |
| `token` | string | No | Figma PAT (falls back to `FIGMA_TOKEN` env var) |
| `format` | `terminal` \| `json` | No | Output format (default: `terminal`) |
| `min_touch_target` | number | No | Minimum touch target size in px (default: 44) |
| `skip` | string[] | No | Checks to skip |

### Example prompts in Claude

```
Scan this Figma prototype for issues: https://www.figma.com/design/abc123/My-App
```

```
Run protoscan on file key YOUR_FIGMA_FILE_KEY and return JSON
```

## Manual usage

```bash
# Run directly
FIGMA_TOKEN=your_token npx @protoscan/mcp

# Or install globally
npm install -g @protoscan/mcp
FIGMA_TOKEN=your_token mcp-protoscan
```

## Related packages

- [`@protoscan/cli`](https://www.npmjs.com/package/@protoscan/cli) — Command-line interface
- [`@protoscan/core`](https://www.npmjs.com/package/@protoscan/core) — Core analysis library
- [GitHub](https://github.com/oxxo/protoscan)
