import pc from 'picocolors';

import type { PushResponse, TranslationStatus } from './commands/push.js';
import type { LintCell, LintIssue, LintResponse } from './commands/lint.js';
import type { Config } from './config.js';
import { toFsLocale } from './patterns.js';

const MAX_ORPHANS: number = 20;
const MAX_UNKNOWN: number = 5;
/** APPROVED gets no label: it is all a project without review ever sees. */
const STATUS_LABEL: Partial<Record<TranslationStatus, string>> = { DRAFT: 'draft', NEEDS_REVIEW: 'needs review' };

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
  staleReset: number;
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
    staleReset: res.staleReset ?? 0,
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

export function renderPush(res: PushResponse, view: { prune?: boolean } = {}): string {
  const lines: string[] = [res.dryRun ? pc.yellow('Dry run: nothing was written.') : pc.green('Pushed.')];

  for (const [locale, c] of Object.entries(res.locales).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let line: string =
      `  ${pc.bold(locale.padEnd(8))} ${pc.green(`${c.created} created`)}, ${pc.cyan(`${c.updated} updated`)}, ` +
      pc.dim(`${c.unchanged} unchanged`);
    if (c.skippedFilled > 0) line += pc.dim(`, ${c.skippedFilled} kept (already translated; --overwrite-targets replaces them)`);
    const label: string | undefined = c.status === undefined ? undefined : STATUS_LABEL[c.status];
    if (label !== undefined && c.created + c.updated > 0) line += pc.magenta(` · ${label}`);
    lines.push(line);
    if (c.unknownKeys.length > 0) {
      const more: string = c.unknownKeys.length > MAX_UNKNOWN ? ', …' : '';
      lines.push(
        pc.yellow(`           ${c.unknownKeys.length} unknown key(s) skipped: ${c.unknownKeys.slice(0, MAX_UNKNOWN).join(', ')}${more}`),
      );
    }
  }

  const stale: number = res.staleReset ?? 0;
  if (stale > 0) {
    lines.push(
      pc.yellow(
        `${stale} approved translation(s) ${res.dryRun ? 'would go' : 'went'} back to review because their source text changed.`,
      ),
    );
  }

  // `pruned` is what a dry run would delete or a real push did delete: unpublished orphans only.
  const unpublished = res.orphans.filter((orphan) => !orphan.published);
  const published = res.orphans.filter((orphan) => orphan.published);
  const listed = unpublished;
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
          : `Deleted ${res.pruned} key(s) that were not in your source files${
              listed.length > res.pruned ? ` (${listed.length - res.pruned} kept: published during the push)` : ''
            }:`;
    lines.push(pc.yellow(`  ${header}`));
    names(listed);
    if (res.pruned === 0 && view.prune !== true) lines.push(pc.dim('  Use --prune to delete them.'));
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

const MAX_VALUE: number = 80;
/** Where the issue text starts: 4 indent + locale 8 + 1 + severity 8 + 1. */
const VALUE_INDENT: string = ' '.repeat(22);

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;
const braces = (arg: string | undefined): string => `{${arg ?? '?'}}`;

/** One line of plain English per issue; a code this CLI does not know prints as-is. */
const issueText = (issue: LintIssue): string => {
  const categories: string = (issue.categories ?? []).join(', ');
  switch (issue.code) {
    case 'ICU_INVALID':
      return `invalid ICU: ${issue.message ?? 'parse error'}${issue.offset === undefined || issue.offset === null ? '' : ` at ${issue.offset}`}`;
    case 'PLACEHOLDER_MISSING':
      return `missing placeholder ${braces(issue.arg)}`;
    case 'PLACEHOLDER_EXTRA':
      return `unexpected placeholder ${braces(issue.arg)}`;
    case 'PLACEHOLDER_KIND_MISMATCH':
      return `placeholder ${braces(issue.arg)} is used differently than in the source`;
    case 'PLURAL_CATEGORY_MISSING':
      return `plural ${braces(issue.arg)} is missing ${categories}`;
    case 'PLURAL_CATEGORY_UNKNOWN':
      return `plural ${braces(issue.arg)} has categories this locale does not use: ${categories}`;
    default:
      return issue.code;
  }
};

const cut = (value: string): string => (value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value);

/** A cell with issues as lint reports it, or as a refused publish names it (no `value` there). */
export type IssueCell = Pick<LintCell, 'namespace' | 'key' | 'locale' | 'issues'> & { value?: string };

/**
 * ESLint-style: namespace, then key, then one line per issue with the locale as named on disk.
 * Rows arrive sorted by the server; only the grouping headers are added here.
 */
export function renderIssueCells(cells: IssueCell[], config: Config | undefined): string[] {
  const lines: string[] = [];
  let namespace: string | undefined;
  let key: string | undefined;
  for (const cell of cells) {
    if (cell.namespace !== namespace) {
      namespace = cell.namespace;
      key = undefined;
      lines.push(pc.bold(namespace));
    }
    if (cell.key !== key) {
      key = cell.key;
      lines.push(`  ${key}`);
    }
    const locale: string = (config === undefined ? cell.locale : toFsLocale(cell.locale, config)).padEnd(8);
    for (const issue of cell.issues) {
      const label: string = issue.severity === 'ERROR' ? pc.red('error'.padEnd(8)) : pc.yellow('warning'.padEnd(8));
      lines.push(`    ${locale} ${label} ${issueText(issue)}`);
      if (issue.code === 'ICU_INVALID' && cell.value !== undefined) {
        lines.push(`${VALUE_INDENT}${pc.dim(JSON.stringify(cut(cell.value)))}`);
      }
    }
  }

  return lines;
}

export function renderLint(res: LintResponse, config: Config, view: { severity?: 'error' | 'warning' } = {}): string {
  const { errors, warnings } = res.summary;
  if (errors + warnings === 0) return pc.green(`✔ No issues in ${res.summary.locales.length} locale(s).`);

  const lines: string[] = renderIssueCells(res.cells, config);

  if (res.truncated) {
    const matched: number = view.severity === 'error' ? errors : view.severity === 'warning' ? warnings : errors + warnings;
    lines.push(
      pc.yellow(`Showing first ${res.cells.length} of ${matched} cells. Narrow with --namespace / --locale, or use --json.`),
    );
  }

  const perLocale: string = res.summary.locales
    .filter((row) => row.errors + row.warnings > 0)
    .map((row) => `${toFsLocale(row.locale, config)} ${row.errors}/${row.warnings}`)
    .join(' · ');
  const totals: string = `${plural(errors, 'error')}, ${plural(warnings, 'warning')}${perLocale === '' ? '' : ` — ${perLocale}`}`;
  if (lines.length > 0) lines.push('');
  lines.push(errors > 0 ? pc.red(`✖ ${totals}`) : pc.yellow(`⚠ ${totals}`));

  return lines.join('\n');
}
