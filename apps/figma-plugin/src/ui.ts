// ProtoScan Figma Plugin UI

interface PluginIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  screenName: string;
  screenId: string;
  message: string;
}

interface ScanStats {
  screens: number;
  startingPoints: number;
  totalIssues: number;
  bySeverity: { critical: number; high: number; medium: number; low: number };
}

const app = document.getElementById('app')!;
let activeFilter: string | null = null;
let lastIssues: PluginIssue[] = [];
let lastStats: ScanStats = { screens: 0, startingPoints: 0, totalIssues: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 } };

function esc(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderResults(issues: PluginIssue[], stats: ScanStats) {
  lastIssues = issues;
  lastStats = stats;

  if (stats.screens === 0) {
    app.innerHTML = `
      <div class="header">
        <h2>ProtoScan</h2>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-value">0</div><div class="stat-label">Screens</div></div>
        <div class="stat"><div class="stat-value">${stats.startingPoints}</div><div class="stat-label">Starting Points</div></div>
        <div class="stat"><div class="stat-value">0</div><div class="stat-label">Issues</div></div>
      </div>
      <div class="empty">
        <div class="empty-icon" style="color:var(--figma-color-text-secondary,#999)">?</div>
        <div class="empty-title">No screens found</div>
        <div class="empty-text">This page has no prototype frames. Make sure your screens are top-level frames (or inside sections).</div>
      </div>
      <div class="actions">
        <button class="btn btn-secondary" id="rescan-btn">Re-scan</button>
      </div>
    `;
    document.getElementById('rescan-btn')?.addEventListener('click', rescan);
    return;
  }

  if (stats.totalIssues === 0) {
    app.innerHTML = `
      <div class="header">
        <h2>ProtoScan</h2>
      </div>
      <div class="stats">
        <div class="stat clean"><div class="stat-value">${stats.screens}</div><div class="stat-label">Screens</div></div>
        <div class="stat"><div class="stat-value">${stats.startingPoints}</div><div class="stat-label">Starting Points</div></div>
        <div class="stat clean"><div class="stat-value">0</div><div class="stat-label">Issues</div></div>
      </div>
      <div class="empty">
        <div class="empty-icon">&#10003;</div>
        <div class="empty-title">Prototype looks good!</div>
        <div class="empty-text">No prototype issues found across 7 checks.</div>
      </div>
      <div class="actions">
        <button class="btn btn-secondary" id="rescan-btn">Re-scan</button>
      </div>
    `;
    document.getElementById('rescan-btn')?.addEventListener('click', rescan);
    return;
  }

  const filtered = activeFilter
    ? issues.filter((i) => i.severity === activeFilter)
    : issues;

  const issuesHtml = filtered.map((issue, i) => `
    <div class="issue ${esc(issue.severity)}" data-index="${issues.indexOf(issue)}">
      <div class="issue-header">
        <span class="issue-severity ${esc(issue.severity)}">${esc(issue.severity)}</span>
        <span class="issue-category">${esc(issue.category)}</span>
      </div>
      <div class="issue-message">${esc(issue.message)}</div>
    </div>
  `).join('');

  const filterBtn = (sev: string, count: number, label: string) => {
    const active = activeFilter === sev ? ' filter-active' : '';
    return count > 0 ? `<button class="filter-chip${active}" data-filter="${sev}">${label} (${count})</button>` : '';
  };

  app.innerHTML = `
    <div class="header">
      <h2>ProtoScan</h2>
      <span style="font-size:11px;color:var(--figma-color-text-secondary,#999)">${stats.screens} screens</span>
    </div>
    <div class="stats">
      <div class="stat critical"><div class="stat-value">${stats.bySeverity.critical}</div><div class="stat-label">Critical</div></div>
      <div class="stat high"><div class="stat-value">${stats.bySeverity.high}</div><div class="stat-label">High</div></div>
      <div class="stat"><div class="stat-value">${stats.bySeverity.medium}</div><div class="stat-label">Medium</div></div>
      <div class="stat"><div class="stat-value">${stats.totalIssues}</div><div class="stat-label">Total</div></div>
    </div>
    <div class="filters">
      <button class="filter-chip${!activeFilter ? ' filter-active' : ''}" data-filter="">All</button>
      ${filterBtn('critical', stats.bySeverity.critical, 'Critical')}
      ${filterBtn('high', stats.bySeverity.high, 'High')}
      ${filterBtn('medium', stats.bySeverity.medium, 'Medium')}
      ${filterBtn('low', stats.bySeverity.low, 'Low')}
    </div>
    <div class="issues">${issuesHtml}</div>
    <div class="actions">
      <button class="btn btn-primary" id="rescan-btn">Re-scan</button>
      <button class="btn btn-secondary" id="close-btn">Close</button>
    </div>
    <div class="cta">
      Catch more with Pro — runtime simulation + video walkthrough <a href="https://polar.sh/checkout?productId=120d4359-72d8-4c07-bfe2-bfea4d29874f" target="_blank">Learn more</a>
    </div>
  `;

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((el) => {
    el.addEventListener('click', () => {
      const f = (el as HTMLElement).dataset.filter ?? '';
      activeFilter = f || null;
      renderResults(lastIssues, lastStats);
    });
  });

  // Issue click → focus in Figma
  document.querySelectorAll('.issue').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = parseInt((el as HTMLElement).dataset.index ?? '0', 10);
      const issue = issues[idx];
      if (issue) {
        parent.postMessage({ pluginMessage: { type: 'focus-node', nodeId: issue.screenId } }, '*');
      }
    });
  });
  document.getElementById('rescan-btn')?.addEventListener('click', rescan);
  document.getElementById('close-btn')?.addEventListener('click', () => {
    parent.postMessage({ pluginMessage: { type: 'close' } }, '*');
  });
}

function rescan() {
  activeFilter = null;
  app.innerHTML = '<div class="loading">Re-scanning...</div>';
  parent.postMessage({ pluginMessage: { type: 'rescan' } }, '*');
}

window.onmessage = (event) => {
  const msg = event.data.pluginMessage;
  if (msg?.type === 'scan-results') {
    renderResults(msg.issues, msg.stats);
  }
};
