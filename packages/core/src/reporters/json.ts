import type { ScanResult } from '../types.js';

export function formatJson(result: ScanResult): string {
  const output = {
    file: result.file,
    summary: result.summary,
    issues: result.issues,
    duration: result.duration,
    timestamp: result.timestamp,
    skippedChecks: result.skippedChecks,
  };
  return JSON.stringify(output, null, 2);
}
