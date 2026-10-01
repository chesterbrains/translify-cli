import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { CliError, EXIT } from './errors.js';

// Same shapes the BE validates, so a bad value fails here with a field path instead of as a 4xx.
const NAMESPACE = /^[a-z0-9-]+$/;
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const fileRule = z
  .object({
    pattern: z
      .string()
      .min(1)
      .refine((value) => value.includes('{locale}'), { message: 'must contain {locale}' }),
    format: z.enum(['json', 'xliff', 'arb']),
    namespace: z.string().regex(NAMESPACE, 'must be lowercase kebab-case').max(64).optional(),
    jsonStyle: z.enum(['nested', 'flat']).optional(),
  })
  .superRefine((rule, ctx) => {
    const hasPlaceholder: boolean = rule.pattern.includes('{namespace}');
    if (rule.format === 'arb' && rule.namespace === undefined) {
      ctx.addIssue({ code: 'custom', path: ['namespace'], message: 'ARB files need a fixed namespace' });
    } else if (!hasPlaceholder && rule.namespace === undefined) {
      ctx.addIssue({ code: 'custom', path: ['namespace'], message: 'needed when the pattern has no {namespace}' });
    }
    if (rule.jsonStyle !== undefined && rule.format !== 'json') {
      ctx.addIssue({ code: 'custom', path: ['jsonStyle'], message: 'only applies to format "json"' });
    }
  })
  .transform((rule) => (rule.format === 'json' ? { ...rule, jsonStyle: rule.jsonStyle ?? 'nested' } : rule));

const configSchema = z
  .object({
    $schema: z.string().optional(),
    apiUrl: z.url(),
    files: z.array(fileRule),
    // filesystem locale -> Translify code; the target must already be a valid Translify locale
    locales: z.record(z.string(), z.string().regex(LOCALE, 'must be a locale code such as en-US')).default({}),
  })
  .strict();

export type Config = Omit<z.infer<typeof configSchema>, '$schema'>;
export type FileRule = Config['files'][number];
export type Format = FileRule['format'];

export async function loadConfig(cwd: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(join(cwd, 'translify.json'), 'utf8');
  } catch {
    throw new CliError(EXIT.failed, 'No translify.json here. Run `translify init` to create one.');
  }

  let json: unknown;
  try {
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    throw new CliError(EXIT.failed, 'translify.json is not valid JSON.');
  }

  if (typeof json === 'object' && json !== null && Object.keys(json).some((key) => /key|secret|token/i.test(key))) {
    throw new CliError(EXIT.failed, 'Never put a key in translify.json — set TRANSLIFY_SECRET_KEY or run `translify login`.');
  }

  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliError(EXIT.failed, `translify.json: ${issue?.path.join('.')} ${issue?.message}`);
  }

  const { apiUrl, files, locales } = parsed.data;

  return { apiUrl, files, locales };
}
