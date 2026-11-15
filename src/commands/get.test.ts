import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { explainKeyError, isMissingRoute, KEY_ROUTES_UNSUPPORTED, runGet, type GetKeyResponse, type GetOptions } from './get.js';

const rule = (namespace?: string) => ({
  pattern: namespace === undefined ? 'locales/{locale}/{namespace}.json' : `locales/{locale}/${namespace}.json`,
  format: 'json' as const,
  jsonStyle: 'nested' as const,
  ...(namespace === undefined ? {} : { namespace }),
});
const config = (files: ReturnType<typeof rule>[], locales: Record<string, string> = {}): Config =>
  ({ apiUrl: 'http://x', files, locales }) as unknown as Config;

const RES: GetKeyResponse = {
  namespace: 'common',
  key: 'promo.title',
  description: null,
  cells: [
    { locale: 'en', isDefault: true, value: 'Limited offer', status: 'APPROVED', issueSeverity: null },
    { locale: 'fr', isDefault: false, value: 'Offre\nlimitée', status: 'NEEDS_REVIEW', issueSeverity: 'ERROR' },
    { locale: 'es', isDefault: false, value: null, status: null, issueSeverity: null },
  ],
};

const run = async (res: GetKeyResponse, key: string, locale: string | undefined, opts: GetOptions = {}, cfg: Config = config([rule()])) => {
  const get = vi.fn().mockResolvedValue(res);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runGet(key, locale, opts, { api: { get } as never, config: cfg, out: (l) => out.push(l), err: (l) => err.push(l) });

  return { code, get, out: out.join('\n'), err: err.join('\n') };
};

const runFailing = async (error: unknown, key: string) => {
  const get = vi.fn().mockRejectedValue(error);

  return runGet(key, undefined, {}, { api: { get } as never, config: config([rule()]), out: () => undefined, err: () => undefined });
};

describe('runGet', () => {
  it('no locale: a table of every locale', async () => {
    const { code, out, get } = await run(RES, 'promo.title', undefined);
    expect(code).toBe(EXIT.ok);
    expect(get).toHaveBeenCalledWith('/cli/v1/key', { key: 'promo.title' });
    expect(out).toBe(
      [
        'Namespace: common',
        'Key:       promo.title',
        '',
        'LOCALE  STATUS        ISSUES  VALUE',
        'en      APPROVED              Limited offer',
        'fr      NEEDS_REVIEW  error   Offre\\nlimitée',
        'es      -                     (empty)',
      ].join('\n'),
    );
  });

  it('with a locale: the raw value only, real newlines', async () => {
    expect((await run(RES, 'promo.title', 'fr')).out).toBe('Offre\nlimitée');
  });

  it('an empty cell: nothing on stdout, a line on stderr, exit 1', async () => {
    const { code, out, err } = await run(RES, 'promo.title', 'es');
    expect([code, out, err]).toEqual([EXIT.failed, '', 'No es translation for promo.title.']);
  });

  it('a locale that is not a cell is refused', async () => {
    await expect(run(RES, 'promo.title', 'de')).rejects.toMatchObject({
      exitCode: EXIT.failed,
      message: 'Locale de is not an enabled locale of this project.',
    });
  });

  it('--json prints the server body; the single configured namespace is sent; a disk alias is mapped', async () => {
    const cfg = config([rule('shop')], { fr_FR: 'fr' });
    const { out, get } = await run(RES, 'promo.title', 'fr_FR', { json: true }, cfg);
    expect(JSON.parse(out)).toEqual(RES);
    expect(get).toHaveBeenCalledWith('/cli/v1/key', { key: 'promo.title', namespace: 'shop' });
  });

  it('--json with an empty cell still exits 1 after printing', async () => {
    const { code, out } = await run(RES, 'promo.title', 'es', { json: true });
    expect(code).toBe(EXIT.failed);
    expect(JSON.parse(out)).toEqual(RES);
  });

  it.each([
    [{ statusCode: 404, code: 'KEY_NOT_FOUND', archived: false }, "Key 'promo.title' not found."],
    [
      { statusCode: 404, code: 'KEY_NOT_FOUND', archived: true },
      "Key 'promo.title' not found. It is in the trash; restore it in Translify or set its source text.",
    ],
    [
      { statusCode: 409, code: 'NAMESPACE_AMBIGUOUS', namespaces: ['common', 'shop'] },
      "Key 'promo.title' exists in namespaces common, shop. Re-run with --namespace <ns>.",
    ],
    [{ statusCode: 404 }, KEY_ROUTES_UNSUPPORTED],
  ])('refusal %j', async (details, message) => {
    await expect(runFailing(new CliError(EXIT.failed, 'x', details), 'promo.title')).rejects.toMatchObject({ exitCode: EXIT.failed, message });
  });
});

describe('explainKeyError', () => {
  it.each([
    [{ code: 'NAMESPACE_REQUIRED' }, "'k' is a new key: say where it lives with --namespace <ns>."],
    [{ code: 'SOURCE_REQUIRED', defaultLocale: 'en' }, "Key 'k' does not exist. Set its source text (en) first."],
    [
      { code: 'SOURCE_REQUIRED', defaultLocale: null },
      "Key 'k' does not exist. This project has no default locale; set one in Translify first.",
    ],
    [{ code: 'KEY_ARCHIVED' }, "Key 'k' is in the trash. Restore it in Translify, or set its source text to bring it back."],
    [{ code: 'KEY_NOT_FOUND', archived: false }, "Key 'k' not found."],
    [{ code: 'NAMESPACE_AMBIGUOUS', namespaces: ['a', 'b'] }, "Key 'k' exists in namespaces a, b. Re-run with --namespace <ns>."],
  ])('%j', (details, message) => {
    const original = new CliError(EXIT.failed, 'server text', details);
    const result = explainKeyError(original, 'k');
    expect(result).toBeInstanceOf(CliError);
    expect(result).toMatchObject({ exitCode: EXIT.failed, message, details });
  });

  it('keeps the original exit code', () => {
    expect(explainKeyError(new CliError(EXIT.network, 'x', { code: 'KEY_ARCHIVED' }), 'k')).toMatchObject({ exitCode: EXIT.network });
  });

  it('returns anything else unchanged', () => {
    const other = new CliError(EXIT.auth, 'x', { code: 'KEY_INVALID' });
    expect(explainKeyError(other, 'k')).toBe(other);
    const plain = new Error('boom');
    expect(explainKeyError(plain, 'k')).toBe(plain);
  });
});

describe('isMissingRoute', () => {
  it('is a 404 without a code only', () => {
    expect(isMissingRoute(new CliError(EXIT.failed, 'x', { statusCode: 404 }))).toBe(true);
    expect(isMissingRoute(new CliError(EXIT.failed, 'x', { statusCode: 404, code: 'KEY_NOT_FOUND' }))).toBe(false);
    expect(isMissingRoute(new Error('x'))).toBe(false);
  });
});
