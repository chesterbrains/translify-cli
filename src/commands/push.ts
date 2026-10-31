import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Config } from '../config.js';
import type { ExitCode } from '../errors.js';
import type { Api } from '../http.js';
import type { Match } from '../patterns.js';
import { pathContext } from '../context.js';
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
  /** Status target cells land in. Omitted → the server decides from the project's review setting. */
  status?: PushStatusFlag;
}

export const PUSH_STATUSES = ['draft', 'needs-review', 'approved'] as const;
export type PushStatusFlag = (typeof PUSH_STATUSES)[number];
export type TranslationStatus = 'DRAFT' | 'NEEDS_REVIEW' | 'APPROVED';

const WIRE_STATUS: Record<PushStatusFlag, TranslationStatus> = {
  draft: 'DRAFT',
  'needs-review': 'NEEDS_REVIEW',
  approved: 'APPROVED',
};

export interface LocaleCounts {
  created: number;
  updated: number;
  unchanged: number;
  skippedFilled: number;
  unknownKeys: string[];
  /** Status the cells written for this locale landed in. Absent on an older server. */
  status?: TranslationStatus;
}

/** The BE's push response; the same shape for a dry run and a real push. */
export interface PushResponse {
  dryRun: boolean;
  locales: Record<string, LocaleCounts>;
  /** Keys in the pushed namespaces that no source file names. A prune archives every one of them (they go to the trash). */
  orphans: Array<{ namespace: string; key: string }>;
  /** Orphans a prune archived (a dry run: would archive). */
  pruned: number;
  /** Archived keys a source file named, restored from the trash in place. Absent on an older server. */
  keysRestored?: number;
  /** Approved targets demoted to needs-review because this push changed their source. Absent on an older server. */
  staleReset?: number;
  /** Hex SHA-256 of the orphans; a confirmed prune sends it back. Absent on an older server. */
  pruneDigest?: string;
  /** Non-blocking notes from the server (e.g. an XLIFF <file original> that differs from the rule). Absent when none. */
  warnings?: string[];
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

/** One form field per file (`file0`, `file1`, …): the server matches by field, never by filename. */
const buildForm = (uploads: Upload[], opts: PushOptions, dryRun: boolean, prune: boolean, pruneDigest?: string): FormData => {
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
        ...(match.rule.format === 'xliff' && match.rule.xliffDialect !== undefined ? { dialect: match.rule.xliffDialect } : {}),
        ...(match.rule.format === 'xliff' && match.rule.xliffOriginal !== undefined ? { original: match.rule.xliffOriginal } : {}),
        ...(match.rule.format === 'yaml' && match.rule.yamlDialect !== undefined
          ? {
              dialect: match.rule.yamlDialect,
              ...(match.diskLocale !== undefined ? { fileLocale: match.diskLocale } : {}),
            }
          : {}),
      })),
    ),
  );
  form.set('dryRun', String(dryRun));
  form.set('overwriteTargets', String(opts.overwriteTargets === true));
  form.set('prune', String(prune));
  if (pruneDigest !== undefined) form.set('pruneDigest', pruneDigest);
  // No default on the wire: the server resolves an absent status from the project's review setting.
  if (opts.status !== undefined) form.set('status', WIRE_STATUS[opts.status]);
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
  // Every orphan is archived, live ones included: they keep serving until the next publish.
  const archivable: number = preview.orphans.length;
  if (opts.prune === true && archivable > 0) {
    damage.push(`move ${archivable} key(s) and their translations to the trash (restorable for 30 days in Translify)`);
  }
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
  const matches: Match[] = (await findFiles(deps.config, deps.cwd, await pathContext(deps.config, deps.api))).filter(
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
  const show = (res: PushResponse, preview?: PushResponse): void => {
    if (opts.json !== true) for (const warning of res.warnings ?? []) deps.out(`warning: ${warning}`);
    deps.out(
      opts.json === true
        ? JSON.stringify({ preview, response: res, summary: summarizePush(res) })
        : renderPush(res, { prune: opts.prune === true }),
    );
  };

  const destructive: boolean = opts.prune === true || opts.overwriteTargets === true;
  if (opts.dryRun === true || !destructive) {
    // Plain push or an explicit dry run: one request, nothing to confirm.
    show(await deps.api.post<PushResponse>(PUSH, buildForm(uploads, opts, opts.dryRun === true, opts.prune === true)));

    return EXIT.ok;
  }

  const preview: PushResponse = await deps.api.post<PushResponse>(PUSH, buildForm(uploads, opts, true, opts.prune === true));
  if (opts.prune === true && typeof preview.pruneDigest !== 'string') {
    deps.err(
      'This server cannot confirm a prune (its dry run returned no pruneDigest), so --prune would archive without a bound. ' +
        'Nothing was changed. Upgrade the Translify server, or push without --prune.',
    );

    return EXIT.failed;
  }
  const damage: string[] = await describeDamage(preview, opts, deps.api);

  // Nothing would be archived or overwritten: no question to ask (F19).
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

  // With orphans the real push sends the digest of the list the user confirmed: if the server's orphan
  // set differs it answers 409 ORPHANS_CHANGED and writes nothing. With none, there is nothing to prune.
  const prune: boolean = opts.prune === true && preview.orphans.length > 0;
  const res: PushResponse = await deps.api.post<PushResponse>(
    PUSH,
    buildForm(uploads, opts, false, prune, prune ? preview.pruneDigest : undefined),
  );
  show(res, preview);

  return EXIT.ok;
}
