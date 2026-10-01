import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config } from '../config.js';
import type { ExitCode } from '../errors.js';
import type { Api } from '../http.js';
import type { Match } from '../patterns.js';
import { CliError, EXIT } from '../errors.js';
import { findFiles } from '../patterns.js';
import { renderPush, summarizePush } from '../render.js';

export interface PushOptions {
  dryRun?: boolean;
  overwriteTargets?: boolean;
  prune?: boolean;
  yes?: boolean;
  namespace?: string;
  json?: boolean;
}

export interface LocaleCounts {
  created: number;
  updated: number;
  unchanged: number;
  skippedFilled: number;
  unknownKeys: string[];
}

/** The BE's push response; the same shape for a dry run and a real push. */
export interface PushResponse {
  dryRun: boolean;
  locales: Record<string, LocaleCounts>;
  orphans: Array<{ namespace: string; key: string; published: boolean; createdAt: string }>;
  pruned: number;
  /** The server's transaction start: a prune only deletes orphans created before it. */
  asOf: string;
}

interface Whoami {
  /** Null when the project has no default locale: then every locale's updates count. */
  project: { defaultLocale: string | null };
}

export interface PushDeps {
  cwd: string;
  config: Config;
  api: Api;
  isTty: boolean;
  confirm: (question: string) => Promise<boolean>;
  /** stdout: the result. */
  out: (line: string) => void;
  /** stderr: hints, refusals, and the preview when stdout carries JSON. */
  err: (line: string) => void;
}

interface Upload {
  match: Match;
  field: string;
  /** Copied into a plain ArrayBuffer: `File` does not accept a pooled Buffer's type. */
  bytes: Uint8Array<ArrayBuffer>;
}

const PUSH: string = '/cli/v1/push';
const MAX_FILES: number = 500;

const orphanId = (orphan: { namespace: string; key: string }): string => `${orphan.namespace}:${orphan.key}`;

/** One form field per file (`file0`, `file1`, …): the server matches by field, never by filename. */
const buildForm = (uploads: Upload[], opts: PushOptions, dryRun: boolean, pruneAsOf?: string): FormData => {
  const form: FormData = new FormData();
  form.set(
    'manifest',
    JSON.stringify(
      uploads.map(({ field, match }) => ({
        field,
        path: match.path,
        format: match.rule.format,
        locale: match.locale,
        namespace: match.namespace,
      })),
    ),
  );
  form.set('dryRun', String(dryRun));
  form.set('overwriteTargets', String(opts.overwriteTargets === true));
  form.set('prune', String(opts.prune === true));
  if (pruneAsOf !== undefined) form.set('pruneAsOf', pruneAsOf);
  for (const { field, match, bytes } of uploads) form.append(field, new File([bytes], match.path));

  return form;
};

/**
 * What a confirmed push would destroy, from its dry run. `updated` also counts
 * source-locale edits, which happen without the flag, so overwrites are the
 * target locales' `updated` only; the source locale comes from whoami.
 */
const describeDamage = async (preview: PushResponse, opts: PushOptions, api: Api): Promise<string[]> => {
  const damage: string[] = [];
  // Published orphans are kept by the server, so they are not part of the damage.
  const deletable: number = preview.orphans.filter((orphan) => !orphan.published).length;
  if (opts.prune === true && deletable > 0) damage.push(`delete ${deletable} key(s) and all their translations`);
  if (opts.overwriteTargets === true) {
    const { project }: Whoami = await api.get<Whoami>('/cli/v1/whoami');
    const overwritten: Array<[string, number]> = Object.entries(preview.locales)
      .filter(([locale, counts]) => locale !== project.defaultLocale && counts.updated > 0)
      .map(([locale, counts]) => [locale, counts.updated]);
    const total: number = overwritten.reduce((sum, [, count]) => sum + count, 0);
    if (total > 0) {
      const byLocale: string = overwritten.map(([locale, count]) => `${locale}: ${count}`).join(', ');
      damage.push(`overwrite ${total} existing translation(s) (${byLocale})`);
    }
  }

  return damage;
};

export async function runPush(opts: PushOptions, deps: PushDeps): Promise<ExitCode> {
  const matches: Match[] = (await findFiles(deps.config, deps.cwd)).filter(
    (match) => opts.namespace === undefined || match.namespace === opts.namespace,
  );
  if (matches.length === 0) {
    const scope: string = opts.namespace === undefined ? '' : ` for namespace "${opts.namespace}"`;
    deps.err(`No files matched the translify.json patterns${scope}.`);

    return EXIT.failed;
  }

  if (matches.length > MAX_FILES) {
    throw new CliError(EXIT.failed, `Too many files (${matches.length} > ${MAX_FILES}): split the push with --namespace.`);
  }

  const uploads: Upload[] = await Promise.all(
    matches.map(async (match, index) => ({
      match,
      field: `file${index}`,
      bytes: new Uint8Array(await readFile(join(deps.cwd, match.path))),
    })),
  );
  const show = (res: PushResponse, preview?: PushResponse, since?: string): void => {
    deps.out(opts.json === true ? JSON.stringify({ preview, response: res, summary: summarizePush(res) }) : renderPush(res, since));
  };

  const destructive: boolean = opts.prune === true || opts.overwriteTargets === true;
  if (opts.dryRun === true || !destructive) {
    // Plain push or an explicit dry run: one request, nothing to confirm.
    show(await deps.api.post<PushResponse>(PUSH, buildForm(uploads, opts, opts.dryRun === true)));

    return EXIT.ok;
  }

  const preview: PushResponse = await deps.api.post<PushResponse>(PUSH, buildForm(uploads, opts, true));
  const damage: string[] = await describeDamage(preview, opts, deps.api);

  // Nothing would be deleted or overwritten: no question to ask (F19).
  if (damage.length > 0) {
    // With --json, stdout is reserved for the final document.
    (opts.json === true ? deps.err : deps.out)(renderPush(preview));
    const question: string = `This will ${damage.join(' and ')}. Continue?`;
    if (opts.yes !== true) {
      if (!deps.isTty) {
        deps.err(`${question}\nRefusing without a terminal; nothing was changed. Re-run with --yes to confirm.`);

        return EXIT.failed;
      }
      if (!(await deps.confirm(question))) {
        deps.err('Cancelled; nothing was changed.');

        return EXIT.failed;
      }
    }
  }

  // The real push deletes only unpublished orphans created before the dry run's asOf; with every orphan
  // published, damage is empty, there is no prompt, and the real push prunes nothing.
  const pruneAsOf: string | undefined = opts.prune === true ? preview.asOf : undefined;
  const res: PushResponse = await deps.api.post<PushResponse>(PUSH, buildForm(uploads, opts, false, pruneAsOf));
  show(res, preview, pruneAsOf);

  if (pruneAsOf !== undefined) {
    const cutoff: number = Date.parse(pruneAsOf);
    const fresh: string[] = res.orphans
      .filter((orphan) => !orphan.published && Date.parse(orphan.createdAt) > cutoff)
      .map(orphanId);
    if (fresh.length > 0) {
      deps.err(`${fresh.length} new orphan(s) appeared since the dry run and were kept: ${fresh.join(', ')}`);
    }
  }

  return EXIT.ok;
}
