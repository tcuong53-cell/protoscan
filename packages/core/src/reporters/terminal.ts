import type { Issue, ScanResult } from '../types.js';

const NO_COLOR = !!process.env.NO_COLOR;

const colors = {
  red: (s: string) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
  yellow: (s: string) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
  blue: (s: string) => (NO_COLOR ? s : `\x1b[34m${s}\x1b[0m`),
  gray: (s: string) => (NO_COLOR ? s : `\x1b[90m${s}\x1b[0m`),
  bold: (s: string) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
  dim: (s: string) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
};

const severityIcon: Record<Issue['severity'], string> = {
  critical: NO_COLOR ? '[CRIT]' : '🔴',
  high: NO_COLOR ? '[HIGH]' : '🟠',
  medium: NO_COLOR ? '[MED] ' : '🟡',
  low: NO_COLOR ? '[LOW] ' : '⚪',
};

const severityColor: Record<Issue['severity'], (s: string) => string> = {
  critical: colors.red,
  high: colors.yellow,
  medium: colors.blue,
  low: colors.gray,
};

export function formatTerminal(result: ScanResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(colors.bold(`ProtoScan — ${result.file.name}`));
  lines.push(colors.dim(`File: ${result.file.key} | Screens: ${result.summary.screens.total} | ${result.duration}ms`));
  lines.push('');

  if (result.issues.length === 0) {
    lines.push('  ✅ No issues found!');
    lines.push('');
    return lines.join('\n');
  }

  // Group by severity, split by confidence
  const grouped = groupBySeverity(result.issues);

  for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
    const issues = grouped[severity];
    if (!issues?.length) continue;

    const realIssues = issues.filter((i) => i.confidence !== 'low');
    const noiseIssues = issues.filter((i) => i.confidence === 'low');

    lines.push(severityColor[severity](`  ${severity.toUpperCase()} (${issues.length})`));

    for (const issue of realIssues) {
      lines.push(`    ${severityIcon[severity]} ${colors.bold(issue.category)} — ${issue.screenName || '(file-level)'}`);
      lines.push(`      ${issue.message}`);
    }

    if (noiseIssues.length > 0) {
      lines.push(colors.dim(`    … ${noiseIssues.length} low-confidence issue${noiseIssues.length > 1 ? 's' : ''} (possible false positives — use --format html to review)`));
    }
    lines.push('');
  }

  // Summary
  const { summary } = result;
  const parts = [];
  if (summary.bySeverity.critical) parts.push(colors.red(`${summary.bySeverity.critical} critical`));
  if (summary.bySeverity.high) parts.push(colors.yellow(`${summary.bySeverity.high} high`));
  if (summary.bySeverity.medium) parts.push(colors.blue(`${summary.bySeverity.medium} medium`));
  if (summary.bySeverity.low) parts.push(colors.gray(`${summary.bySeverity.low} low`));

  const noisePart = summary.total - summary.likelyReal;
  const likelyRealSuffix = noisePart > 0
    ? colors.dim(` · ${summary.likelyReal} likely real, ${noisePart} low-confidence`)
    : '';

  lines.push(colors.bold(`  Found ${summary.total} issues (${parts.join(', ')})`) + likelyRealSuffix);

  if (result.skippedChecks.length > 0) {
    lines.push(colors.dim(`  Skipped checks: ${result.skippedChecks.join(', ')}`));
  }

  if (summary.total > 0) {
    lines.push(colors.dim('  ProtoScan Pro: AI vision analysis + video recording → https://protoscan.dev/pro'));
  }
  lines.push('');
  return lines.join('\n');
}

function groupBySeverity(issues: Issue[]): Record<string, Issue[]> {
  const groups: Record<string, Issue[]> = {};
  for (const issue of issues) {
    (groups[issue.severity] ??= []).push(issue);
  }
  return groups;
}
