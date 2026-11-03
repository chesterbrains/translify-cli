import fg from 'fast-glob';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { type Config, type FileRule, isSymfonyDialect } from '../config.js';
import type { ExitCode } from '../errors.js';
import type { Api } from '../http.js';
import { pathContext } from '../context.js';
import { CliError, EXIT, ONLY_APPROVED_NEEDS_WORKING } from '../errors.js';
import { compile, pathFor, type PathContext, toFsLocale, toTranslifyLocale } from '../patterns.js';
import { renderReasonCells, type ReasonCell } from '../render.js';

interface PullResponse {
  files: Array<{ locale: string; namespace: string; format: string; content: string }>;
  warnings: string[];
}

export interface PullOptions {
  from?: string;
  locale?: string;
  namespace?: string;
  /** `status`: compare only, write nothing. */
  check?: boolean;
  /** Approved text only; cells never approved are left out. Working copy only. */
  onlyApproved?: boolean;
  json?: boolean;
}

export interface PullDeps {
  cwd: string;
  config: Config;
  api: Api;
  out: (line: string) => void;
}

const readOrUndefined = async (path: string): Promise<string | undefined> =>
  readFile(path, 'utf8').catch(() => undefined);

/** `fileLocales` rides in the query string; proxies cap the request line (nginx: 8 KB), so one request carries at most this many characters of it. */
const FILE_LOCALES_MAX: number = 1500;

/** Greedy groups of `code:disk` pairs, each joined within FILE_LOCALES_MAX. */
const chunkPairs = (pairs: Array<[string, string]>): Array<Array<[string, string]>> => {
  const chunks: Array<Array<[string, string]>> = [];
  let size = 0;
  for (const pair of pairs) {
    const length: number = pair[0].length + pair[1].length + 2;
    if (chunks.length === 0 || size + length > FILE_LOCALES_MAX) {
      chunks.push([]);
      size = 0;
    }
    chunks.at(-1)!.push(pair);
    size += length;
  }

  return chunks;
};

const NESTED_CONFLICT: RegExp = /nested JSON cannot hold both/;

/** The 422 `XLIFF_DIALECT_UNSUPPORTED` / `ANDROID_UNSUPPORTED` / `YAML_UNSUPPORTED` body: up to 100 cells, `total` counts them all. */
interface DialectBody {
  code: 'XLIFF_DIALECT_UNSUPPORTED' | 'ANDROID_UNSUPPORTED' | 'STRINGS_UNSUPPORTED' | 'YAML_UNSUPPORTED';
  total: number;
  cells: ReasonCell[];
}

const isDialectUnsupported = (details: unknown): details is DialectBody =>
  typeof details === 'object' &&
  details !== null &&
  ['XLIFF_DIALECT_UNSUPPORTED', 'ANDROID_UNSUPPORTED', 'STRINGS_UNSUPPORTED', 'YAML_UNSUPPORTED'].includes((details as { code?: string }).code ?? '');

const dialectHint = (code: DialectBody['code']): string =>
  code === 'STRINGS_UNSUPPORTED'
    ? 'Split the text so each key is plain text with placeholders or one plural (`=0` allowed; no `select`), or move the key to a JSON rule.'
    : 'Split the text so each key is plain text with placeholders or one plural/select (Android: one plural), or move the key to a JSON rule.';

const YAML_HINTS: Record<string, string> = {
  arrayGap: 'Translate every item of the list, or clear them all.',
  invalidRaw: 'Fix the value so it is the same kind as the source (true/false, a number, a :symbol list).',
  literalPipe: 'Rephrase the text so it has no literal "|": Symfony reads it as a plural separator.',
  keyConflict: 'Rename one of the keys: YAML cannot nest below a key that has a value.',
};
const YAML_ICU_HINT: string = 'Rewrite each key as plain text with placeholders or one plural, or move the key to a JSON rule.';

/** One hint per reason group present, each once; the ICU hint covers every other reason. */
const yamlHints = (cells: ReasonCell[]): string[] => {
  const hints: string[] = [];
  for (const { reason } of cells) {
    const hint: string = YAML_HINTS[reason] ?? YAML_ICU_HINT;
    if (!hints.includes(hint)) hints.push(hint);
  }

  return hints.length === 0 ? [YAML_ICU_HINT] : hints;
};

/** The server's one-line refusal, the cells grouped like `lint`, and the way out. */
const dialectRefusal = (body: DialectBody, config: Config, dialect: string = 'angular'): CliError => {
  const cells: ReasonCell[] = Array.isArray(body.cells) ? body.cells : [];
  const target: string =
    body.code === 'ANDROID_UNSUPPORTED'
      ? 'Android strings.xml'
      : body.code === 'STRINGS_UNSUPPORTED'
        ? 'iOS .strings/.stringsdict'
        : body.code === 'YAML_UNSUPPORTED'
          ? dialect === 'rails'
            ? 'Rails YAML'
            : 'Symfony YAML'
          : `XLIFF for ${dialect}`;
  const lines: string[] = [
    `Pull refused: ${body.total} translation(s) cannot be written as ${target}. Nothing was written.`,
    ...renderReasonCells(cells, config),
  ];
  if (body.total > cells.length) lines.push(`Showing first ${cells.length} of ${body.total}.`);
  lines.push(...(body.code === 'YAML_UNSUPPORTED' ? yamlHints(cells) : [dialectHint(body.code)]));

  return new CliError(EXIT.issues, lines.join('\n'), body);
};

/**
 * Flutter's gen_l10n requires `@@locale` to match the file name, and only the CLI knows the disk
 * mapping. Rewrites the value in place (key order kept) with the server's own formatting so the
 * output is byte-stable; content that is not a JSON object is left alone.
 */
const withDiskLocale = (content: string, translifyLocale: string, config: Config): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return content;
  const doc: Record<string, unknown> = parsed as Record<string, unknown>;
  if (typeof doc['@@locale'] !== 'string') return content;
  doc['@@locale'] = toFsLocale(translifyLocale, config);

  return `${JSON.stringify(doc, null, 2)}\n`;
};

const isSymfonyWildcard = (rule: FileRule): boolean =>
  rule.namespace === undefined && rule.format === 'yaml' && isSymfonyDialect(rule.yamlDialect);

/**
 * Wildcard Symfony rules share the namespace space (`messages.en.yaml` vs `messages+intl-icu.en.yaml`): each namespace
 * belongs to the rule with a file for it on disk, any locale. Both on disk is an error; none falls to the first rule.
 */
const symfonyOwners = async (rules: FileRule[], claimed: Set<string>, cwd: string): Promise<Map<string, { rule: FileRule; path: string }>> => {
  const owners: Map<string, { rule: FileRule; path: string }> = new Map();
  for (const rule of rules) {
    const { glob, regex } = compile(rule.pattern, false);
    const paths: string[] = await fg(glob, { cwd, onlyFiles: true, dot: false });
    for (const path of paths.map((value) => value.replaceAll('\\', '/')).sort()) {
      const groups = regex.exec(path)?.groups;
      if (groups?.locale === undefined || groups.namespace === undefined || claimed.has(groups.namespace)) continue;
      const owner: { rule: FileRule; path: string } | undefined = owners.get(groups.namespace);
      if (owner === undefined) owners.set(groups.namespace, { rule, path });
      else if (owner.rule !== rule) {
        throw new CliError(
          EXIT.failed,
          `${owner.path} and ${path} both hold Symfony domain ${groups.namespace}: keep one of them (legacy or +intl-icu), then pull again.`,
        );
      }
    }
  }

  return owners;
};

/** Server warnings start with `<locale>/<namespace>: `. */
const WARNING_NAMESPACE: RegExp = /^[^/\s]+\/([a-z0-9-]+): /;

/** A Windows checkout (autocrlf, BOM) must not count as drift. */
const normalizeEol = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

export async function runPull(opts: PullOptions, deps: PullDeps): Promise<ExitCode> {
  // Environments already apply the gate; the server would 400 this, fail before any request.
  if (opts.onlyApproved && opts.from !== undefined && opts.from !== 'working') {
    throw new CliError(EXIT.failed, ONLY_APPROVED_NEEDS_WORKING);
  }

  const changed: string[] = [];
  const created: string[] = [];
  const responses: PullResponse[] = [];
  const lines: string[] = [];
  let flatHinted = false;
  // Phase 1 plans every write; nothing touches disk until every request and check has passed.
  const plan: Array<{ path: string; absolute: string; content: string }> = [];
  const seen: Map<string, string> = new Map<string, string>();

  // Namespaces a fixed-namespace rule owns must not also be written by a `{namespace}` rule.
  const claimed: Set<string> = new Set(
    deps.config.files.flatMap((rule) => (rule.namespace === undefined ? [] : [rule.namespace])),
  );

  // Checked before any request: two Symfony files for one domain would refuse the next push anyway.
  const symfonyRules: FileRule[] = deps.config.files.filter(isSymfonyWildcard);
  const owners: Map<string, { rule: FileRule; path: string }> = await symfonyOwners(symfonyRules, claimed, deps.cwd);
  const ownerOf = (namespace: string): FileRule | undefined => owners.get(namespace)?.rule ?? symfonyRules[0];
  /** The ICU rule asks for every namespace first (its pre-check is the lenient one); the legacy rules then ask only for theirs. */
  const lead: FileRule | undefined = symfonyRules.find((rule) => rule.yamlDialect === 'symfony-icu');
  /** Every namespace the server has, from the lead's response; unknown until it ran (or when there is no lead). */
  let allNamespaces: string[] | undefined;

  const context: PathContext = await pathContext(deps.config, deps.api);

  // `files` order stands; only the lead moves, right before the first Symfony wildcard rule, so it runs ahead of the others.
  const rules: FileRule[] =
    lead === undefined
      ? deps.config.files
      : deps.config.files.flatMap((rule) => {
          if (rule === symfonyRules[0]) return rule === lead ? [rule] : [lead, rule];

          return rule === lead ? [] : [rule];
        });
  for (const rule of rules) {
    if (opts.namespace !== undefined && rule.namespace !== undefined && rule.namespace !== opts.namespace) continue;
    const wildcard: boolean = rule.namespace === undefined;
    if (wildcard && opts.namespace !== undefined && claimed.has(opts.namespace)) continue;
    const symfonyWildcard: boolean = symfonyRules.includes(rule);
    if (symfonyWildcard && opts.namespace !== undefined && ownerOf(opts.namespace) !== rule) continue;
    /** A non-lead Symfony rule behind a lead asks for exactly the namespaces it owns. */
    let owned: string[] | undefined;
    if (symfonyWildcard && lead !== undefined && rule !== lead && opts.namespace === undefined) {
      owned = (allNamespaces ?? []).filter((namespace) => ownerOf(namespace) === rule);
      if (owned.length === 0) continue;
    }

    const base: Record<string, string> = { format: rule.format };
    if (rule.format === 'json' && rule.jsonStyle !== undefined) base.jsonStyle = rule.jsonStyle;
    if (rule.format === 'xliff' && rule.xliffDialect !== undefined) base.dialect = rule.xliffDialect;
    if (rule.format === 'xliff' && rule.xliffOriginal !== undefined) base.original = rule.xliffOriginal;
    /** One request, or several when the Rails alias pairs do not fit one query string; `accept` picks the locales each one is trusted for. */
    let variants: Array<{ extra: Record<string, string>; accept: (locale: string) => boolean }> = [{ extra: {}, accept: () => true }];
    if (rule.format === 'yaml' && rule.yamlDialect !== undefined) {
      base.dialect = rule.yamlDialect;
      if (isSymfonyDialect(rule.yamlDialect) && rule.jsonStyle !== undefined) base.jsonStyle = rule.jsonStyle;
    }
    if (rule.format === 'yaml' && rule.yamlDialect === 'rails') {
      // The file's locale key follows the disk name (en_US), the server only knows Translify codes.
      const requested: string[] = opts.locale === undefined ? Object.values(deps.config.locales) : [toTranslifyLocale(opts.locale, deps.config)];
      // Only locales the project has can come back; an older server (no `locales` in whoami) keeps the whole map.
      const projectLocales: Set<string> | undefined = context.locales === undefined ? undefined : new Set(context.locales);
      const pairs: Array<[string, string]> = [...new Set(requested)]
        .filter((code) => projectLocales === undefined || projectLocales.has(code))
        .filter((code) => toFsLocale(code, deps.config) !== code)
        .map((code): [string, string] => [code, toFsLocale(code, deps.config)]);
      const chunks: Array<Array<[string, string]>> = chunkPairs(pairs);
      const format = (chunk: Array<[string, string]>): string => chunk.map(([code, disk]) => `${code}:${disk}`).join(',');
      if (chunks.length === 1) variants = [{ extra: { fileLocales: format(chunks[0]!) }, accept: () => true }];
      else if (chunks.length > 1) {
        // Each chunk is asked for its own locales only; one last request serves every locale without an alias.
        const aliased: Set<string> = new Set(pairs.map(([code]) => code));
        variants = [
          ...chunks.map((chunk) => {
            const codes: Set<string> = new Set(chunk.map(([code]) => code));

            return { extra: { fileLocales: format(chunk), locales: [...codes].join(',') }, accept: (locale: string) => codes.has(locale) };
          }),
          { extra: {}, accept: (locale: string) => !aliased.has(locale) },
        ];
      }
    }
    if (opts.from !== undefined) base.from = opts.from;
    if (opts.onlyApproved) base.approvedOnly = 'true';
    if (opts.locale !== undefined) base.locales = toTranslifyLocale(opts.locale, deps.config);
    const namespace: string | undefined = rule.namespace ?? opts.namespace;
    if (namespace !== undefined) base.namespaces = namespace;
    else if (owned !== undefined) base.namespaces = owned.join(',');

    // A split pull reports one merged response per rule: only the files its request was trusted for, each warning once.
    const merged: PullResponse = { files: [], warnings: [] };
    if (variants.length > 1) responses.push(merged);
    for (const variant of variants) {
      const res: PullResponse = await deps.api.get<PullResponse>('/cli/v1/pull', { ...base, ...variant.extra }).catch((error: unknown) => {
        if (error instanceof CliError && isDialectUnsupported(error.details)) {
          throw dialectRefusal(error.details, deps.config, rule.yamlDialect ?? rule.xliffDialect);
        }
        throw error;
      });
      if (rule === lead && opts.namespace === undefined) allNamespaces = [...new Set(res.files.map((file) => file.namespace))];
      if (variants.length === 1) responses.push(res);
      else merged.files.push(...res.files.filter((file) => variant.accept(file.locale)));
      for (const warning of res.warnings) {
        // The lead asks for every namespace; a warning about one another rule owns is that rule's to print.
        // The server emits no pull warnings for yaml yet (only json's nested conflict), so this is a forward guard.
        const about: string | undefined = WARNING_NAMESPACE.exec(warning)?.[1];
        if (rule === lead && about !== undefined && ownerOf(about) !== lead) continue;
        if (variants.length > 1) {
          if (merged.warnings.includes(warning)) continue;
          merged.warnings.push(warning);
        }
        lines.push(`warning: ${warning}`);
        if (!flatHinted && NESTED_CONFLICT.test(warning)) {
          flatHinted = true;
          lines.push('hint: set "jsonStyle": "flat" on this files rule in translify.json to keep both keys.');
        }
      }

      for (const file of res.files) {
        if (!variant.accept(file.locale)) continue;
        if (wildcard && claimed.has(file.namespace)) continue;
        if (symfonyWildcard && ownerOf(file.namespace) !== rule) continue;

        const path: string = pathFor(rule, file.locale, file.namespace, deps.config, context);
        const absolute: string = resolve(deps.cwd, path);
        const rel: string = relative(resolve(deps.cwd), absolute);
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
          throw new CliError(EXIT.failed, `Refusing to write ${path}: it resolves outside the project directory.`);
        }

        // Two server locales can back-map to one disk locale; writing both would clobber one every run.
        const cell = `${file.locale}/${file.namespace}`;
        const other: string | undefined = seen.get(absolute);
        if (other !== undefined) {
          throw new CliError(
            EXIT.failed,
            `${path} would be written for both ${other} and ${cell}. Fix the "locales" map so each Translify locale has its own file.`,
          );
        }
        seen.set(absolute, cell);

        const content: string = rule.format === 'arb' ? withDiskLocale(file.content, file.locale, deps.config) : file.content;
        const existing: string | undefined = await readOrUndefined(absolute);
        if (existing !== undefined && (existing === content || normalizeEol(existing) === content)) continue;

        (existing === undefined ? created : changed).push(path);
        plan.push({ path, absolute, content });
      }
    }
  }

  if (!opts.check) {
    for (const item of plan) {
      await mkdir(dirname(item.absolute), { recursive: true });
      await writeFile(item.absolute, item.content);
    }
  }

  const drift: string[] = [...changed, ...created];
  if (opts.json) {
    deps.out(JSON.stringify({ responses, summary: { check: opts.check === true, changed: drift, created } }));
  } else {
    for (const line of lines) deps.out(line);
    if (drift.length === 0) deps.out(opts.check ? 'Up to date.' : 'Nothing to update.');
    else {
      const rows: string[] = [
        ...changed.map((path) => `  ${path}`),
        ...created.map((path) => `  ${path} (new)`),
      ];
      deps.out(`${opts.check ? 'Out of date' : 'Updated'}:\n${rows.join('\n')}`);
    }
  }

  return opts.check && drift.length > 0 ? EXIT.failed : EXIT.ok;
}
