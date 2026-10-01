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

export function renderPush(res: PushResponse, since?: string): string {
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

  // `pruned` is what a dry run would delete or a real push did delete: unpublished orphans only.
  // `since` (a real prune) is the dry run's asOf: later orphans were kept, and runPush reports them.
  const isNew = (orphan: PushResponse['orphans'][number]): boolean => since !== undefined && Date.parse(orphan.createdAt) > Date.parse(since);
  const unpublished = res.orphans.filter((orphan) => !orphan.published);
  const published = res.orphans.filter((orphan) => orphan.published);
  const listed = res.pruned > 0 && !res.dryRun ? unpublished.filter((orphan) => !isNew(orphan)) : unpublished;
  const names = (list: typeof listed): void => {
    for (const orphan of list.slice(0, MAX_ORPHANS)) lines.push(`    ${orphan.namespace}:${orphan.key}`);
    if (list.length > MAX_ORPHANS) lines.push(`    …and ${list.length - MAX_ORPHANS} more`);
  };
  if (listed.length > 0) {
    const header: string =
      res.pruned === 0
        ? `${listed.length} key(s) in Translify are not in your source files:`
        : res.dryRun
          ? `${listed.length} key(s) not in your source files would be deleted:`
          : `Deleted ${listed.length} key(s) that were not in your source files:`;
    lines.push(pc.yellow(`  ${header}`));
    names(listed);
    if (res.pruned === 0) lines.push(pc.dim('  Use --prune to delete them.'));
  }
  if (published.length > 0) {
    lines.push(pc.yellow(`  ${published.length} key(s) kept — published; unpublish it in Translify to delete it:`));
    names(published);
  }
  if (res.pruned > 0 && res.dryRun) lines.push(pc.yellow(`  Would delete ${res.pruned} key(s).`));
  // A real prune's orphan header already says it; repeat it only when there was no list.
  if (res.pruned > 0 && !res.dryRun && listed.length === 0) lines.push(pc.red(`  Deleted ${res.pruned} key(s).`));

  return lines.join('\n');
}
