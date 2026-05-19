# Social Media Posts — Figma Workflow Labs Launch

## LinkedIn Post (for design agency decision-makers)

Figma just launched Workflow Labs — teaching teams to use MCP for a code-to-canvas workflow.

Great workflow. But there's a missing step.

Before you share a prototype with your team or client, how do you know it works? Every design agency has the story: "The VP hit a dead end during the demo."

I built ProtoScan — it scans your Figma prototype in 30 seconds and finds dead-end screens, orphan screens, broken navigation, and more. Automatically.

It works as:
- A Claude MCP server (ask Claude to scan your prototype)
- A CLI tool (npx @protoscan/cli scan YOUR_FILE_KEY)
- A CI/CD quality gate

Add it to your Figma MCP setup and never ship a broken prototype again.

Open source (MIT). Free. github.com/oxxo/protoscan

#Figma #UXResearch #PrototypeQA #MCP #DesignOps #ClaudeAI

---

## Twitter/X Post (short, dev-focused)

Figma is teaching millions of users to set up MCP servers via Workflow Labs.

I built the missing piece: @protoscan — automated QA for Figma prototypes.

Dead ends, orphan screens, broken nav — found in 30 seconds.

Works as a Claude MCP server. Add it next to Figma MCP and ask Claude: "scan my prototype"

github.com/oxxo/protoscan

---

## Twitter/X Thread (detailed)

1/ Figma just launched Workflow Labs: "code to canvas" with MCP.

But their workflow is missing a critical step.

2/ The workflow:
1. Set up Figma MCP
2. Push prototypes to Figma
3. Review together
4. Send to code

Where's the QA? You're sharing prototypes without checking if they work.

3/ Every UX researcher knows the pain:
"I ran a $2,000 testing session and 2 participants hit dead ends. Data thrown out."

The fix? Manual click-through. 2-8 hours per prototype.

4/ I built ProtoScan — automated Figma prototype QA in 30 seconds.

It detects:
- Dead-end screens
- Orphan screens
- Missing back navigation
- Small touch targets
- Overlapping hotspots
- Overlay traps

5/ It's an MCP server. Add it next to Figma MCP:

```json
"protoscan": {
  "command": "npx",
  "args": ["-y", "@protoscan/mcp"],
  "env": { "FIGMA_TOKEN": "token" }
}
```

Then ask Claude: "scan my prototype for issues"

6/ Open source. MIT licensed. Free forever for static analysis.

No Figma plugin needed. No account. No signup.

github.com/oxxo/protoscan

---

## DEV Community / Hashnode Article Title Options

1. "The Missing Step in Figma's Code-to-Canvas Workflow: Automated Prototype QA"
2. "I Built the First MCP Server for Figma Prototype QA"
3. "How to QA Your Figma Prototype in 30 Seconds with Claude and MCP"
4. "Stop Shipping Broken Figma Prototypes — Automate QA with ProtoScan"
