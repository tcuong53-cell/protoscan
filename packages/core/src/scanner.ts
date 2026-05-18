import type { AnalyzerOptions, FigmaFile, Issue, ScanResult, ScanStats } from './types.js';
import { buildGraph } from './graph/builder.js';
import { graphAnalyzer, resetIssueCounter } from './graph/analyzer.js';
import { touchTargetAnalyzer } from './spatial/touch-targets.js';
import { overlapAnalyzer } from './spatial/overlap.js';
import { scrollAnalyzer } from './spatial/scroll.js';
import { overlayTrapAnalyzer } from './spatial/overlay-traps.js';

export interface ScanOptions extends AnalyzerOptions {
  fileKey: string;
  /** Pre-computed issues from external analyzers (e.g. simulator) to merge into results */
  additionalIssues?: Issue[];
}

export async function scan(file: FigmaFile, options: ScanOptions): Promise<ScanResult> {
  const start = performance.now();
  resetIssueCounter();

  const graph = buildGraph(file, { pageIds: options.pageIds });
  const skip = new Set(options.skip ?? []);
  const issues: Issue[] = [];

  // Graph analysis
  const graphIssues = await graphAnalyzer.analyze(file, options, graph);
  issues.push(...graphIssues);

  // Spatial analysis
  if (!skip.has('touch-target')) {
    issues.push(...await touchTargetAnalyzer.analyze(file, options));
  }
  if (!skip.has('overlap')) {
    issues.push(...await overlapAnalyzer.analyze(file, options));
  }
  if (!skip.has('scroll')) {
    issues.push(...await scrollAnalyzer.analyze(file, options));
  }
  if (!skip.has('overlay-trap')) {
    issues.push(...await overlayTrapAnalyzer.analyze(file, options, graph));
  }

  if (options.additionalIssues?.length) {
    issues.push(...options.additionalIssues);
  }

  const duration = Math.round(performance.now() - start);
  const summary = buildSummary(issues, graph.nodes.size);

  return {
    file: { name: file.name, key: options.fileKey, lastModified: file.lastModified },
    graph,
    issues,
    summary,
    duration,
    timestamp: new Date().toISOString(),
    skippedChecks: options.skip ?? [],
  };
}

function buildSummary(issues: Issue[], totalScreens: number): ScanStats {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategory: Record<string, number> = {};
  const screensWithIssues = new Set<string>();
  let likelyReal = 0;

  for (const issue of issues) {
    bySeverity[issue.severity]++;
    byCategory[issue.category] = (byCategory[issue.category] ?? 0) + 1;
    if (issue.screenId) screensWithIssues.add(issue.screenId);
    if (issue.confidence !== 'low') likelyReal++;
  }

  return {
    total: issues.length,
    likelyReal,
    bySeverity,
    byCategory: byCategory as ScanStats['byCategory'],
    screens: { total: totalScreens, withIssues: screensWithIssues.size },
  };
}
