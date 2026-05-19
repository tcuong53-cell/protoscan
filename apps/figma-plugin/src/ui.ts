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

// Prevent XSS — escape all user-controlled strings before inserting into HTML
function esc(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function renderResults(issues: PluginIssue[], stats: ScanStats) {
  // Empty state: no screens found on this page
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
      <div class="cta">
        Get AI vision analysis + video recording with <a href="https://github.com/oxxo/protoscan#pro" target="_blank">ProtoScan Pro</a>
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
        <div class="empty-text">No dead ends, orphans, or navigation issues found.</div>
      </div>
      <div class="actions">
        <button class="btn btn-secondary" id="rescan-btn">Re-scan</button>
      </div>
      <div class="cta">
        Get AI vision analysis + video recording with <a href="https://github.com/oxxo/protoscan#pro" target="_blank">ProtoScan Pro</a>
      </div>
    `;
    document.getElementById('rescan-btn')?.addEventListener('click', rescan);
    return;
  }

  const issuesHtml = issues.map((issue, i) => `
    <div class="issue ${esc(issue.severity)}" data-index="${i}">
      <div class="issue-header">
        <span class="issue-severity ${esc(issue.severity)}">${esc(issue.severity)}</span>
        <span class="issue-category">${esc(issue.category)}</span>
      </div>
      <div class="issue-message">${esc(issue.message)}</div>
    </div>
  `).join('');

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
    <div class="issues">${issuesHtml}</div>
    <div class="actions">
      <button class="btn btn-primary" id="rescan-btn">Re-scan</button>
      <button class="btn btn-secondary" id="close-btn">Close</button>
    </div>
    <div class="cta">
      Want AI vision analysis + video recording? <a href="https://github.com/oxxo/protoscan#pro" target="_blank">ProtoScan Pro</a>
    </div>
  `;

  // Attach click handlers via addEventListener (not inline onclick — prevents XSS)
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
  app.innerHTML = '<div class="loading">Re-scanning...</div>';
  parent.postMessage({ pluginMessage: { type: 'rescan' } }, '*');
}

// Listen for messages from plugin code
window.onmessage = (event) => {
  const msg = event.data.pluginMessage;
  if (msg?.type === 'scan-results') {
    renderResults(msg.issues, msg.stats);
  }
};
