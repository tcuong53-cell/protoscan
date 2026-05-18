import type { Issue, ScanResult } from '../types.js';

export function formatHtml(result: ScanResult): string {
  const { file, summary, issues, duration, skippedChecks } = result;
  const grouped = groupBySeverity(issues);
  const categoryData = JSON.stringify(summary.byCategory);
  const severityData = JSON.stringify(summary.bySeverity);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ProtoScan Report — ${esc(file.name)}</title>
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
    --text: #e4e4e7; --muted: #71717a; --accent: #6366f1;
    --critical: #ef4444; --high: #f97316; --medium: #eab308; --low: #6b7280;
    --green: #22c55e;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }

  /* Header */
  .header { margin-bottom: 32px; }
  .header h1 { font-size: 28px; font-weight: 700; margin-bottom: 4px; }
  .header h1 span { color: var(--accent); }
  .header .meta { color: var(--muted); font-size: 14px; }

  /* Summary Cards */
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; }
  .card .value { font-size: 36px; font-weight: 700; }
  .card .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }
  .card.critical .value { color: var(--critical); }
  .card.high .value { color: var(--high); }
  .card.medium .value { color: var(--medium); }
  .card.low .value { color: var(--low); }
  .card.screens .value { color: var(--accent); }
  .card.clean .value { color: var(--green); }
  .card.time .value { color: var(--muted); font-size: 24px; }

  /* Charts */
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 32px; }
  .chart-box { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
  .chart-box h3 { font-size: 14px; color: var(--muted); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .bar-row { display: flex; align-items: center; margin-bottom: 8px; gap: 8px; }
  .bar-label { width: 140px; font-size: 13px; color: var(--muted); text-align: right; }
  .bar-track { flex: 1; height: 24px; background: var(--bg); border-radius: 6px; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 6px; display: flex; align-items: center; padding: 0 8px; font-size: 12px; font-weight: 600; min-width: 28px; }
  .bar-fill.critical { background: var(--critical); }
  .bar-fill.high { background: var(--high); color: #000; }
  .bar-fill.medium { background: var(--medium); color: #000; }
  .bar-fill.low { background: var(--low); }

  /* Filters */
  .filters { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .filter-btn { background: var(--surface); border: 1px solid var(--border); color: var(--muted); padding: 6px 14px; border-radius: 20px; font-size: 13px; cursor: pointer; transition: all 0.15s; }
  .filter-btn:hover, .filter-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }

  /* Issues */
  .issues-header { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
  .issue { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 8px; display: flex; gap: 12px; align-items: flex-start; transition: opacity 0.2s; }
  .issue.hidden { display: none; }
  .severity-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; flex-shrink: 0; }
  .severity-dot.critical { background: var(--critical); box-shadow: 0 0 8px var(--critical); }
  .severity-dot.high { background: var(--high); }
  .severity-dot.medium { background: var(--medium); }
  .severity-dot.low { background: var(--low); }
  .issue-body { flex: 1; }
  .issue-title { font-weight: 600; font-size: 14px; }
  .issue-screen { color: var(--muted); font-size: 13px; margin-top: 2px; }
  .issue-category { display: inline-block; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; font-size: 11px; color: var(--muted); margin-top: 6px; }

  /* Footer */
  .footer { margin-top: 48px; padding-top: 24px; border-top: 1px solid var(--border); text-align: center; color: var(--muted); font-size: 13px; }
  .footer a { color: var(--accent); text-decoration: none; }

  /* Responsive */
  @media (max-width: 768px) {
    .charts { grid-template-columns: 1fr; }
    .cards { grid-template-columns: repeat(2, 1fr); }
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f8f9fa; --surface: #fff; --border: #e5e7eb;
      --text: #1f2937; --muted: #6b7280;
    }
  }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1><span>ProtoScan</span> — ${esc(file.name)}</h1>
    <div class="meta">
      ${summary.screens.total} screens · ${summary.total} issues · ${duration}ms · ${new Date(result.timestamp).toLocaleDateString()}
      ${skippedChecks.length ? ` · Skipped: ${skippedChecks.join(', ')}` : ''}
    </div>
  </div>

  <div class="cards">
    <div class="card screens"><div class="value">${summary.screens.total}</div><div class="label">Screens</div></div>
    <div class="card critical"><div class="value">${summary.bySeverity.critical}</div><div class="label">Critical</div></div>
    <div class="card high"><div class="value">${summary.bySeverity.high}</div><div class="label">High</div></div>
    <div class="card medium"><div class="value">${summary.bySeverity.medium}</div><div class="label">Medium</div></div>
    <div class="card low"><div class="value">${summary.bySeverity.low}</div><div class="label">Low</div></div>
    <div class="card time"><div class="value">${duration}ms</div><div class="label">Scan Time</div></div>
  </div>

  <div class="charts">
    <div class="chart-box">
      <h3>By Category</h3>
      ${renderBars(summary.byCategory, summary.total)}
    </div>
    <div class="chart-box">
      <h3>By Severity</h3>
      ${renderSeverityBars(summary.bySeverity, summary.total)}
    </div>
  </div>

  <div class="filters">
    <button class="filter-btn active" data-filter="all">All (${summary.total})</button>
    ${summary.bySeverity.critical ? `<button class="filter-btn" data-filter="critical">Critical (${summary.bySeverity.critical})</button>` : ''}
    ${summary.bySeverity.high ? `<button class="filter-btn" data-filter="high">High (${summary.bySeverity.high})</button>` : ''}
    ${summary.bySeverity.medium ? `<button class="filter-btn" data-filter="medium">Medium (${summary.bySeverity.medium})</button>` : ''}
    ${summary.bySeverity.low ? `<button class="filter-btn" data-filter="low">Low (${summary.bySeverity.low})</button>` : ''}
  </div>

  <div class="issues-header">Issues</div>
  <div id="issues">
    ${issues.map((issue) => `
    <div class="issue" data-severity="${issue.severity}" data-category="${issue.category}">
      <div class="severity-dot ${issue.severity}"></div>
      <div class="issue-body">
        <div class="issue-title">${esc(issue.message)}</div>
        <div class="issue-screen">${esc(issue.screenName || '(file-level)')}</div>
        <span class="issue-category">${issue.category}</span>
      </div>
    </div>`).join('\n')}
  </div>

  <div class="footer">
    Generated by <a href="https://github.com/oxxo/protoscan">ProtoScan</a> · ${new Date(result.timestamp).toISOString()}
  </div>

</div>
<script>
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const filter = btn.dataset.filter;
    document.querySelectorAll('.issue').forEach(el => {
      el.classList.toggle('hidden', filter !== 'all' && el.dataset.severity !== filter);
    });
  });
});
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function groupBySeverity(issues: Issue[]): Record<string, Issue[]> {
  const groups: Record<string, Issue[]> = {};
  for (const issue of issues) {
    (groups[issue.severity] ??= []).push(issue);
  }
  return groups;
}

function renderBars(data: Record<string, number>, total: number): string {
  const colors: Record<string, string> = {
    'dead-end': 'critical', 'overlay-trap': 'critical', 'orphan': 'high',
    'back-nav': 'high', 'touch-target': 'high', 'incomplete-connection': 'medium',
    'overlap': 'medium', 'scroll': 'medium', 'vision': 'medium',
  };
  return Object.entries(data)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => {
      const pct = total > 0 ? Math.max((count / total) * 100, 8) : 0;
      const color = colors[cat] ?? 'medium';
      return `<div class="bar-row"><div class="bar-label">${cat}</div><div class="bar-track"><div class="bar-fill ${color}" style="width:${pct}%">${count}</div></div></div>`;
    }).join('\n');
}

function renderSeverityBars(data: Record<string, number>, total: number): string {
  return (['critical', 'high', 'medium', 'low'] as const)
    .filter((s) => data[s] > 0)
    .map((sev) => {
      const count = data[sev];
      const pct = total > 0 ? Math.max((count / total) * 100, 8) : 0;
      return `<div class="bar-row"><div class="bar-label">${sev}</div><div class="bar-track"><div class="bar-fill ${sev}" style="width:${pct}%">${count}</div></div></div>`;
    }).join('\n');
}
