import pc from 'picocolors';

import type { PushResponse } from './commands/push.js';

const MAX_ORPHANS: number = 20;
const MAX_UNKNOWN: number = 5;

export interface PushSummary {
  dryRun: boolean;
  created: number;
  updated: number;
  unchanged: number;
  skippedFilled: number;
  unknownKeys: number;
  orphans: number;
  publishedOrphans: number;
  pruned: number;
}

/** Totals across locales, for `--json`. */
export function summarizePush(res: PushResponse): PushSummary {
  const summary: PushSummary = {
    dryRun: res.dryRun,
    created: 0,
    updated: 0,
    unchanged: 0,
    skippedFilled: 0,
    unknownKeys: 0,
    orphans: res.orphans.length,
    publishedOrphans: res.orphans.filter((orphan) => orphan.published).length,
    pruned: res.pruned,
  };
  for (const counts of Object.values(res.locales)) {
    summary.created += counts.created;
    summary.updated += counts.updated;
    summary.unchanged += counts.unchanged;
    summary.skippedFilled += counts.skippedFilled;
    summary.unknownKeys += counts.unknownKeys.length;
  }

  return summary;
}

export function renderPush(res: PushResponse): string {
  const lines: string[] = [res.dryRun ? pc.yellow('Dry run: nothing was written.') : pc.green('Pushed.')];

  for (const [locale, c] of Object.entries(res.locales).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let line: string =
      `  ${pc.bold(locale.padEnd(8))} ${pc.green(`${c.created} created`)}, ${pc.cyan(`${c.updated} updated`)}, ` +
      pc.dim(`${c.unchanged} unchanged`);
    if (c.skippedFilled > 0) line += pc.dim(`, ${c.skippedFilled} kept (already translated; --overwrite-targets replaces them)`);
    lines.push(line);
    if (c.unknownKeys.length > 0) {
      const more: string = c.unknownKeys.length > MAX_UNKNOWN ? ', …' : '';
      lines.push(
        pc.yellow(`           ${c.unknownKeys.length} unknown key(s) skipped: ${c.unknownKeys.slice(0, MAX_UNKNOWN).join(', ')}${more}`),
      );
    }
  }

  // A dry run with prune also reports `pruned`: what a real push would delete.
  if (res.orphans.length > 0) {
    const header: string =
      res.pruned === 0
        ? `${res.orphans.length} key(s) in Translify are not in your source files:`
        : res.dryRun
          ? `${res.orphans.length} key(s) not in your source files would be deleted:`
          : `Deleted ${res.orphans.length} key(s) that were not in your source files:`;
    lines.push(pc.yellow(`  ${header}`));
    for (const orphan of res.orphans.slice(0, MAX_ORPHANS)) {
      const name: string = `${orphan.namespace}:${orphan.key}`;
      lines.push(orphan.published ? `    ${pc.red(name)} ${pc.red('(published)')}` : `    ${name}`);
    }
    if (res.orphans.length > MAX_ORPHANS) lines.push(`    …and ${res.orphans.length - MAX_ORPHANS} more`);
    if (res.pruned === 0) {
      lines.push(pc.dim('  Use --prune to delete them.'));
      if (res.orphans.some((orphan) => orphan.published)) {
        lines.push(pc.dim('  Published keys cannot be pruned: unpublish them first.'));
      }
    }
  }
  if (res.pruned > 0 && res.dryRun) lines.push(pc.yellow(`  Would delete ${res.pruned} key(s).`));
  // A real prune's orphan header already says it; repeat it only when there was no list.
  if (res.pruned > 0 && !res.dryRun && res.orphans.length === 0) lines.push(pc.red(`  Deleted ${res.pruned} key(s).`));

  return lines.join('\n');
}
