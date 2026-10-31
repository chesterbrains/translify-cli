import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../config.js';
import { CliError } from '../errors.js';
import { runPull } from './pull.js';

const config: Config = {
  apiUrl: 'https://x/api',
  files: [
    { pattern: 'locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'flat' },
    { pattern: 'lib/l10n/app_{locale}.arb', format: 'arb', namespace: 'app' },
  ],
  locales: { en_US: 'en-US' },
};

const api = () => ({
  get: vi.fn(async (_path: string, query: Record<string, string>) =>
    query.format === 'json'
      ? { files: [{ locale: 'it', namespace: 'cart', format: 'json', content: '{\n  "a": "A"\n}\n' }], warnings: [] }
      : { files: [{ locale: 'en-US', namespace: 'app', format: 'arb', content: '{\n  "@@locale": "en-US"\n}\n' }], warnings: [] },
  ),
});

const tmp = (): Promise<string> => mkdtemp(join(tmpdir(), 'tfy-'));
const quiet = (): undefined => undefined;

describe('runPull', () => {
  it('requests each rule with its format and options, and writes mapped paths', async () => {
    const cwd = await tmp();
    const client = api();
    const code = await runPull({}, { cwd, config, api: client as never, out: quiet });

    expect(code).toBe(0);
    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', { format: 'json', jsonStyle: 'flat' });
    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', { format: 'arb', namespaces: 'app' });
    expect(await readFile(join(cwd, 'locales/it/cart.json'), 'utf8')).toBe('{\n  "a": "A"\n}\n');
    expect(await readFile(join(cwd, 'lib/l10n/app_en_US.arb'), 'utf8')).toContain('@@locale');
  });

  it('status reports drift with exit 1 and writes nothing', async () => {
    const cwd = await tmp();
    await mkdir(join(cwd, 'locales/it'), { recursive: true });
    await writeFile(join(cwd, 'locales/it/cart.json'), '{\n  "a": "old"\n}\n');
    const lines: string[] = [];

    const code = await runPull({ check: true }, { cwd, config, api: api() as never, out: (line) => lines.push(line) });

    expect(code).toBe(1);
    expect(lines.join('\n')).toMatch(/locales\/it\/cart\.json/);
    expect(lines.join('\n')).toMatch(/lib\/l10n\/app_en_US\.arb/);
    expect(await readFile(join(cwd, 'locales/it/cart.json'), 'utf8')).toContain('old');
    await expect(stat(join(cwd, 'lib'))).rejects.toThrow();
  });

  it('status exits 0 when files match byte for byte', async () => {
    const cwd = await tmp();
    await runPull({}, { cwd, config, api: api() as never, out: quiet });

    expect(await runPull({ check: true }, { cwd, config, api: api() as never, out: quiet })).toBe(0);
  });

  it('passes --from and narrows locale/namespace', async () => {
    const client = api();
    await runPull(
      { from: 'env:production', locale: 'en_US', namespace: 'cart' },
      { cwd: await tmp(), config, api: client as never, out: quiet },
    );

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', {
      format: 'json',
      jsonStyle: 'flat',
      from: 'env:production',
      locales: 'en-US',
      namespaces: 'cart',
    });
  });

  it('a second pull rewrites nothing and leaves the bytes identical', async () => {
    const cwd = await tmp();
    await runPull({}, { cwd, config, api: api() as never, out: quiet });
    const path = join(cwd, 'locales/it/cart.json');
    const before = await stat(path);
    const bytes = await readFile(path);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines: string[] = [];

    await runPull({}, { cwd, config, api: api() as never, out: (line) => lines.push(line) });

    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path)).toEqual(bytes);
    expect(lines.join('\n')).toMatch(/Nothing to update/);
  });

  it('writes content as received, including CRLF', async () => {
    const cwd = await tmp();
    const client = {
      get: vi.fn(async () => ({ files: [{ locale: 'it', namespace: 'cart', format: 'json', content: '{\r\n}\r\n' }], warnings: [] })),
    };
    await runPull({}, { cwd, config: { ...config, files: [config.files[0]!] }, api: client as never, out: quiet });

    expect(await readFile(join(cwd, 'locales/it/cart.json'), 'utf8')).toBe('{\r\n}\r\n');
  });

  it('does not write namespaces claimed by a fixed-namespace rule (F20)', async () => {
    const cwd = await tmp();
    const client = {
      get: vi.fn(async (_p: string, q: Record<string, string>) => (q.format !== 'json' ? { files: [], warnings: [] } : {
        files: [
          { locale: 'it', namespace: 'cart', format: 'json', content: '{}\n' },
          { locale: 'it', namespace: 'app', format: 'json', content: '{}\n' },
          { locale: 'it', namespace: 'web', format: 'json', content: '{}\n' },
        ],
        warnings: [],
      })),
    };
    const cfg: Config = {
      ...config,
      files: [config.files[0]!, config.files[1]!, { pattern: 'xlf/{locale}.xlf', format: 'xliff', namespace: 'web' }],
    };
    const code = await runPull({}, { cwd, config: cfg, api: client as never, out: quiet });

    expect(code).toBe(0);
    await expect(stat(join(cwd, 'locales/it/cart.json'))).resolves.toBeDefined();
    await expect(stat(join(cwd, 'locales/it/app.json'))).rejects.toThrow();
    await expect(stat(join(cwd, 'locales/it/web.json'))).rejects.toThrow();
  });

  it('--namespace skips rules with a different fixed namespace and requests only X for {namespace} rules', async () => {
    const client = api();
    await runPull({ namespace: 'app' }, { cwd: await tmp(), config, api: client as never, out: quiet });

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', { format: 'arb', namespaces: 'app' });
  });

  it('prints server warnings and suggests flat for the nested conflict', async () => {
    const client = {
      get: vi.fn(async () => ({
        files: [],
        warnings: ['it/cart: nested JSON cannot hold both "a" and keys below it; use jsonStyle "flat"', 'other'],
      })),
    };
    const lines: string[] = [];
    const nested: Config = { ...config, files: [{ pattern: 'l/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' }] };
    await runPull({}, { cwd: await tmp(), config: nested, api: client as never, out: (l) => lines.push(l) });

    expect(lines.filter((l) => l.startsWith('warning: '))).toHaveLength(2);
    expect(lines.join('\n')).toMatch(/"jsonStyle": "flat"/);
  });

  it('maps a server locale back to its disk locale', async () => {
    const cwd = await tmp();
    const client = { get: vi.fn(async () => ({ files: [{ locale: 'en-US', namespace: 'cart', format: 'json', content: '{}\n' }], warnings: [] })) };
    await runPull({}, { cwd, config: { ...config, files: [config.files[0]!] }, api: client as never, out: quiet });

    expect(await readFile(join(cwd, 'locales/en_US/cart.json'), 'utf8')).toBe('{}\n');
  });

  it('refuses a path that escapes the repo', async () => {
    const cwd = await tmp();
    const client = { get: vi.fn(async () => ({ files: [{ locale: 'it', namespace: '../../../evil', format: 'json', content: '{}\n' }], warnings: [] })) };

    await expect(
      runPull({}, { cwd, config: { ...config, files: [config.files[0]!] }, api: client as never, out: quiet }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('--json prints the raw responses and a summary', async () => {
    const lines: string[] = [];
    await runPull({ json: true, check: true }, { cwd: await tmp(), config, api: api() as never, out: (l) => lines.push(l) });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.responses).toHaveLength(2);
    expect(parsed.summary.changed).toEqual(expect.arrayContaining(['locales/it/cart.json']));
  });

  it('refuses two server locales that back-map to one file, writing nothing', async () => {
    const cwd = await tmp();
    const client = {
      get: vi.fn(async () => ({
        files: [
          { locale: 'it', namespace: 'cart', format: 'json', content: '{}\n' },
          { locale: 'it-IT', namespace: 'cart', format: 'json', content: '{"a":"b"}\n' },
        ],
        warnings: [],
      })),
    };
    const cfg: Config = { ...config, files: [config.files[0]!], locales: { it: 'it-IT' } };

    await expect(runPull({}, { cwd, config: cfg, api: client as never, out: quiet })).rejects.toThrow(/it\/cart.*it-IT\/cart/);
    await expect(stat(join(cwd, 'locales'))).rejects.toThrow();
  });

  it('writes nothing when a later request fails', async () => {
    const cwd = await tmp();
    let calls = 0;
    const client = {
      get: vi.fn(async (_p: string, q: Record<string, string>) => {
        if (++calls === 2) throw new CliError(1, 'boom');
        return api().get('/cli/v1/pull', q);
      }),
    };

    await expect(runPull({}, { cwd, config, api: client as never, out: quiet })).rejects.toThrow('boom');
    await expect(stat(join(cwd, 'locales'))).rejects.toThrow();
  });

  it('names translify.json in the flat hint', async () => {
    const lines: string[] = [];
    const client = { get: vi.fn(async () => ({ files: [], warnings: ['nested JSON cannot hold both "a" and keys below it'] })) };
    await runPull({}, { cwd: await tmp(), config: { ...config, files: [config.files[0]!] }, api: client as never, out: (l) => lines.push(l) });

    expect(lines.join('\n')).toContain('translify.json');
    expect(lines.join('\n')).not.toContain('translify.config.json');
  });

  it('rewrites ARB @@locale to the disk locale, byte-stable across runs', async () => {
    const cwd = await tmp();
    const client = {
      get: vi.fn(async () => ({
        files: [{ locale: 'en-US', namespace: 'app', format: 'arb', content: '{\n  "@@locale": "en-US",\n  "hi": "Hi"\n}\n' }],
        warnings: [],
      })),
    };
    const only: Config = { ...config, files: [config.files[1]!] };
    await runPull({}, { cwd, config: only, api: client as never, out: quiet });
    const path = join(cwd, 'lib/l10n/app_en_US.arb');

    expect(await readFile(path, 'utf8')).toBe('{\n  "@@locale": "en_US",\n  "hi": "Hi"\n}\n');

    const lines: string[] = [];
    const before = await stat(path);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await runPull({ check: true }, { cwd, config: only, api: client as never, out: (l) => lines.push(l) })).toBe(0);
    await runPull({}, { cwd, config: only, api: client as never, out: quiet });
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it('accepts the underscore @@locale form the server may already send', async () => {
    const cwd = await tmp();
    const client = {
      get: vi.fn(async () => ({
        files: [{ locale: 'en-US', namespace: 'app', format: 'arb', content: '{\n  "@@locale": "en_US"\n}\n' }],
        warnings: [],
      })),
    };
    const only: Config = { ...config, files: [config.files[1]!] };
    await runPull({}, { cwd, config: only, api: client as never, out: quiet });

    expect(await readFile(join(cwd, 'lib/l10n/app_en_US.arb'), 'utf8')).toBe('{\n  "@@locale": "en_US"\n}\n');
  });

  it('treats a CRLF + BOM checkout as unchanged: no drift, no write', async () => {
    const cwd = await tmp();
    await mkdir(join(cwd, 'locales/it'), { recursive: true });
    const path = join(cwd, 'locales/it/cart.json');
    await writeFile(path, '\uFEFF{\r\n  "a": "A"\r\n}\r\n');
    const before = await stat(path);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const only: Config = { ...config, files: [config.files[0]!] };

    expect(await runPull({ check: true }, { cwd, config: only, api: api() as never, out: quiet })).toBe(0);
    expect(await runPull({}, { cwd, config: only, api: api() as never, out: quiet })).toBe(0);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path, 'utf8')).toContain('\r\n');
  });

  it('--only-approved asks every rule for approved text', async () => {
    const client = api();
    await runPull({ onlyApproved: true }, { cwd: await tmp(), config, api: client as never, out: quiet });

    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', { format: 'json', jsonStyle: 'flat', approvedOnly: 'true' });
    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', { format: 'arb', namespaces: 'app', approvedOnly: 'true' });
  });

  it('--only-approved also applies to status', async () => {
    const client = api();
    await runPull({ onlyApproved: true, check: true }, { cwd: await tmp(), config, api: client as never, out: quiet });

    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', { format: 'json', jsonStyle: 'flat', approvedOnly: 'true' });
  });

  it('--only-approved with an env: source exits 1 before any request', async () => {
    const client = api();
    const pending = runPull(
      { onlyApproved: true, from: 'env:production' },
      { cwd: await tmp(), config, api: client as never, out: quiet },
    );

    await expect(pending).rejects.toMatchObject({ exitCode: 1, message: expect.stringMatching(/--from working only/) });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('--only-approved with an explicit --from working is allowed', async () => {
    const client = api();
    await runPull({ onlyApproved: true, from: 'working' }, { cwd: await tmp(), config, api: client as never, out: quiet });

    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', {
      format: 'json',
      jsonStyle: 'flat',
      from: 'working',
      approvedOnly: 'true',
    });
  });
});

describe('runPull xliffDialect', () => {
  const withXliff: Config = {
    apiUrl: 'https://x/api',
    files: [{ pattern: 'src/locale/messages.{locale}.xlf', format: 'xliff', namespace: 'web', xliffDialect: 'angular' }],
    locales: {},
  };

  it('forwards xliffDialect as dialect', async () => {
    const client = {
      get: vi.fn(async () => ({ files: [{ locale: 'it', namespace: 'web', format: 'xliff', content: '<xliff/>\n' }], warnings: [] })),
    };
    await runPull({}, { cwd: await tmp(), config: withXliff, api: client as never, out: quiet });

    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', { format: 'xliff', dialect: 'angular', namespaces: 'web' });
  });

  it('renders XLIFF_DIALECT_UNSUPPORTED like lint, exit 6, writes nothing', async () => {
    const cwd = await tmp();
    const body = {
      code: 'XLIFF_DIALECT_UNSUPPORTED',
      total: 2,
      cells: [
        { namespace: 'web', key: 'mixed', locale: 'en', reason: 'mixedIcu' },
        { namespace: 'web', key: 'price', locale: 'en', reason: 'formattedArg' },
      ],
    };
    const client = {
      get: vi.fn(async () => {
        throw new CliError(6, 'x', body);
      }),
    };

    const failure: unknown = await runPull({}, { cwd, config: withXliff, api: client as never, out: quiet }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).exitCode).toBe(6);
    expect((failure as CliError).message).toMatch(/Pull refused: 2 translation\(s\)/);
    expect((failure as CliError).message).toMatch(/mixed/);
    expect((failure as CliError).message).toMatch(/text next to a plural or select/);
    expect((failure as CliError).message).toMatch(/number, date or time format/);
    await expect(stat(join(cwd, 'src'))).rejects.toThrow();
  });
});

describe('runPull xliffDialect xcode', () => {
  const withXcode: Config = {
    apiUrl: 'https://x/api',
    files: [{ pattern: 'Localization/{locale}.xliff', format: 'xliff', namespace: 'ios', xliffDialect: 'xcode', xliffOriginal: 'Sources/App/Localizable.xcstrings' }],
    locales: {},
  };

  it('forwards dialect and original', async () => {
    const client = {
      get: vi.fn(async () => ({ files: [{ locale: 'it', namespace: 'ios', format: 'xliff', content: '<xliff/>\n' }], warnings: [] })),
    };
    await runPull({}, { cwd: await tmp(), config: withXcode, api: client as never, out: quiet });

    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', {
      format: 'xliff',
      dialect: 'xcode',
      original: 'Sources/App/Localizable.xcstrings',
      namespaces: 'ios',
    });
  });

  it('renders the Xcode refusal reasons', async () => {
    const body = {
      code: 'XLIFF_DIALECT_UNSUPPORTED',
      total: 2,
      cells: [
        { namespace: 'ios', key: 'a', locale: 'en', reason: 'exactMatch' },
        { namespace: 'ios', key: 'b', locale: 'it', reason: 'shapeMismatch' },
      ],
    };
    const client = {
      get: vi.fn(async () => {
        throw new CliError(6, 'x', body);
      }),
    };
    const failure: unknown = await runPull({}, { cwd: await tmp(), config: withXcode, api: client as never, out: quiet }).catch((e: unknown) => e);

    expect((failure as CliError).exitCode).toBe(6);
    expect((failure as CliError).message).toMatch(/Pull refused: 2 translation\(s\) cannot be written as XLIFF for xcode/);
    expect((failure as CliError).message).toMatch(/exact match .* offset/);
    expect((failure as CliError).message).toMatch(/not the same shape/);
  });
});

describe('runPull format android', () => {
  const withAndroid: Config = {
    apiUrl: 'https://x/api',
    files: [{ pattern: 'res/values-{locale}/strings.xml', format: 'android', namespace: 'strings' }],
    locales: {},
  };
  const xml = (locale: string) => ({ locale, namespace: 'strings', format: 'android', content: '<resources/>\n' });

  it('asks whoami once for the default locale and writes values/ and qualifiers', async () => {
    const cwd = await tmp();
    const client = {
      get: vi.fn(async (path: string) =>
        path === '/cli/v1/whoami'
          ? { project: { defaultLocale: 'en' } }
          : { files: [xml('en'), xml('pt-BR'), xml('sr-Latn')], warnings: [] },
      ),
    };
    await runPull({}, { cwd, config: withAndroid, api: client as never, out: quiet });

    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', { format: 'android', namespaces: 'strings' });
    expect(client.get.mock.calls.filter(([path]) => path === '/cli/v1/whoami')).toHaveLength(1);
    for (const dir of ['values', 'values-pt-rBR', 'values-b+sr+Latn']) {
      expect(await readFile(join(cwd, `res/${dir}/strings.xml`), 'utf8')).toBe('<resources/>\n');
    }
  });

  it('renders ANDROID_UNSUPPORTED like the dialect refusal, exit 6', async () => {
    const body = { code: 'ANDROID_UNSUPPORTED', total: 1, cells: [{ namespace: 'strings', key: 'k', locale: 'en', reason: 'arrayGap' }] };
    const client = {
      get: vi.fn(async (path: string) => {
        if (path === '/cli/v1/whoami') return { project: { defaultLocale: 'en' } };
        throw new CliError(6, 'x', body);
      }),
    };

    const failure = (await runPull({}, { cwd: await tmp(), config: withAndroid, api: client as never, out: quiet }).catch((e: unknown) => e)) as CliError;

    expect(failure.exitCode).toBe(6);
    expect(failure.message).toMatch(/Android strings\.xml/);
    expect(failure.message).toMatch(/not contiguous from \.0/);
  });
});

describe('runPull format yaml', () => {
  const rails = (locales: Record<string, string> = {}): Config => ({
    apiUrl: 'https://x/api',
    files: [{ pattern: 'config/locales/{locale}.yml', format: 'yaml', yamlDialect: 'rails', namespace: 'rails' }],
    locales,
  });
  const yml = (locale: string) => ({ locale, namespace: 'rails', format: 'yaml', content: 'a: b\n' });

  it('sends dialect=rails and fileLocales for an aliased locale', async () => {
    const cwd = await tmp();
    const client = { get: vi.fn(async () => ({ files: [yml('en-US')], warnings: [] })) };
    await runPull({}, { cwd, config: rails({ en_US: 'en-US' }), api: client as never, out: quiet });

    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', {
      format: 'yaml',
      dialect: 'rails',
      fileLocales: 'en-US:en_US',
      namespaces: 'rails',
    });
    expect(await readFile(join(cwd, 'config/locales/en_US.yml'), 'utf8')).toBe('a: b\n');
  });

  it('omits fileLocales when no locale is aliased', async () => {
    const client = { get: vi.fn(async () => ({ files: [], warnings: [] })) };
    await runPull({}, { cwd: await tmp(), config: rails(), api: client as never, out: quiet });

    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', { format: 'yaml', dialect: 'rails', namespaces: 'rails' });
  });

  it('renders YAML_UNSUPPORTED like the dialect refusal, exit 6', async () => {
    const body = { code: 'YAML_UNSUPPORTED', total: 1, cells: [{ namespace: 'rails', key: 'k', locale: 'en', reason: 'unsupportedIcu' }] };
    const client = { get: vi.fn(async () => { throw new CliError(6, 'x', body); }) };

    const failure = (await runPull({}, { cwd: await tmp(), config: rails(), api: client as never, out: quiet }).catch((e: unknown) => e)) as CliError;

    expect(failure.exitCode).toBe(6);
    expect(failure.message).toMatch(/Pull refused: 1 translation\(s\) cannot be written as Rails YAML/);
    expect(failure.message).toMatch(/a select, or other ICU/);
    expect(failure.message).not.toMatch(/select\)/);
  });

  it('explains a Rails arrayGap and exactMatch in terms that fit Rails', async () => {
    const body = {
      code: 'YAML_UNSUPPORTED',
      total: 2,
      cells: [
        { namespace: 'rails', key: 'days.1', locale: 'it', reason: 'arrayGap' },
        { namespace: 'rails', key: 'n', locale: 'ar', reason: 'exactMatch' },
      ],
    };
    const client = { get: vi.fn(async () => { throw new CliError(6, 'x', body); }) };

    const failure = (await runPull({}, { cwd: await tmp(), config: rails(), api: client as never, out: quiet }).catch((e: unknown) => e)) as CliError;

    expect(failure.message).toMatch(/a target list only partly translated \(Rails\)/);
    expect(failure.message).toMatch(/in Rails for a locale without a CLDR zero category/);
  });
});

describe('runPull format yaml refusal hints and fileLocales cap', () => {
  const rails = (locales: Record<string, string> = {}): Config => ({
    apiUrl: 'https://x/api',
    files: [{ pattern: 'config/locales/{locale}.yml', format: 'yaml', yamlDialect: 'rails', namespace: 'rails' }],
    locales,
  });
  const refuse = async (reasons: string[]): Promise<string> => {
    const body = {
      code: 'YAML_UNSUPPORTED',
      total: reasons.length,
      cells: reasons.map((reason, i) => ({ namespace: 'rails', key: `k${i}`, locale: 'en', reason })),
    };
    const client = { get: vi.fn(async () => { throw new CliError(6, 'x', body); }) };
    const failure = (await runPull({}, { cwd: await tmp(), config: rails(), api: client as never, out: quiet }).catch((e: unknown) => e)) as CliError;

    return failure.message;
  };

  it('hints per reason group, not the ICU hint for a list gap', async () => {
    const gap = await refuse(['arrayGap']);
    expect(gap).toMatch(/Translate every item of the list, or clear them all\./);
    expect(gap).not.toMatch(/Rewrite each key as plain text/);
  });

  it('hints invalidRaw and keyConflict', async () => {
    expect(await refuse(['invalidRaw'])).toMatch(/Fix the value so it is the same kind as the source \(true\/false, a number, a :symbol list\)\./);
    expect(await refuse(['keyConflict'])).toMatch(/Rename one of the keys: YAML cannot nest below a key that has a value\./);
  });

  it('keeps the ICU hint for ICU reasons, and prints each group once', async () => {
    const icu = await refuse(['unsupportedIcu']);
    expect(icu).toMatch(/Rewrite each key as plain text with placeholders or one plural, or move the key to a JSON rule\./);
    expect(icu).not.toMatch(/Translate every item/);
    const mixed = await refuse(['unsupportedIcu', 'arrayGap', 'arrayGap', 'keyConflict']);
    expect(mixed.match(/Translate every item/g)).toHaveLength(1);
    expect(mixed).toMatch(/Rewrite each key/);
    expect(mixed).toMatch(/Rename one of the keys/);
  });

  it('splits a pull whose aliases exceed the query budget into per-locale-group requests', async () => {
    const locales: Record<string, string> = {};
    for (let i = 0; i < 300; i++) locales[`en_${String(i).padStart(4, '0')}_LONGNAME`] = `en-${String(i).padStart(4, '0')}`;
    const cwd = await tmp();
    const client = {
      get: vi.fn(async (_path: string, query: Record<string, string>) => {
        const codes = query.locales === undefined ? ['en', 'en-0000', 'en-0299'] : query.locales.split(',');
        // The server answers with what was asked; a wrong-root file for another aliased locale must be dropped.
        return { files: codes.filter((c) => c === 'en' || c === 'en-0000' || c === 'en-0299').map((c) => ({ locale: c, namespace: 'rails', format: 'yaml', content: `${c}: {}\n` })), warnings: [] };
      }),
    };
    await runPull({}, { cwd, config: rails(locales), api: client as never, out: quiet });

    const queries = client.get.mock.calls.filter(([path]) => path === '/cli/v1/pull').map(([, q]) => q);
    expect(queries.length).toBeGreaterThan(2);
    for (const q of queries) expect((q.fileLocales ?? '').length).toBeLessThanOrEqual(1500);
    expect(queries.filter((q) => q.fileLocales === undefined && q.locales === undefined)).toHaveLength(1);
    expect(await readFile(join(cwd, 'config/locales/en.yml'), 'utf8')).toBe('en: {}\n');
    expect(await readFile(join(cwd, 'config/locales/en_0000_LONGNAME.yml'), 'utf8')).toBe('en-0000: {}\n');
    expect(await readFile(join(cwd, 'config/locales/en_0299_LONGNAME.yml'), 'utf8')).toBe('en-0299: {}\n');
  });

  it('sends only the aliases of locales the project has (whoami locales), the whole map for an older server', async () => {
    const config = rails({ en_US: 'en-US', pt_BR: 'pt-BR', de_DE: 'de-DE' });
    const modern = { get: vi.fn(async (path: string) => (path === '/cli/v1/whoami' ? { project: { defaultLocale: 'en' }, locales: ['en', 'en-US', 'de-DE'] } : { files: [], warnings: [] })) };
    await runPull({}, { cwd: await tmp(), config, api: modern as never, out: quiet });
    expect(modern.get).toHaveBeenCalledWith('/cli/v1/pull', expect.objectContaining({ fileLocales: 'en-US:en_US,de-DE:de_DE' }));

    const older = { get: vi.fn(async (path: string) => (path === '/cli/v1/whoami' ? { project: { defaultLocale: 'en' } } : { files: [], warnings: [] })) };
    await runPull({}, { cwd: await tmp(), config, api: older as never, out: quiet });
    expect(older.get).toHaveBeenCalledWith('/cli/v1/pull', expect.objectContaining({ fileLocales: 'en-US:en_US,pt-BR:pt_BR,de-DE:de_DE' }));
  });

  it('keeps one request when the pairs fit, and only the requested locale with --locale', async () => {
    const client = { get: vi.fn(async () => ({ files: [], warnings: [] })) };
    await runPull({ locale: 'en_US' }, { cwd: await tmp(), config: rails({ en_US: 'en-US', pt_BR: 'pt-BR' }), api: client as never, out: quiet });

    expect(client.get.mock.calls.filter(([path]) => path === '/cli/v1/pull')).toHaveLength(1);
    expect(client.get).toHaveBeenCalledWith('/cli/v1/pull', expect.objectContaining({ fileLocales: 'en-US:en_US', locales: 'en-US' }));
  });
});

describe('runPull format strings', () => {
  it('renders STRINGS_UNSUPPORTED like the dialect refusal, exit 6', async () => {
    const config: Config = {
      apiUrl: 'https://x/api',
      files: [{ pattern: 'App/{locale}.lproj/Localizable.stringsdict', format: 'stringsdict', namespace: 'localizable' }],
      locales: {},
    };
    const body = { code: 'STRINGS_UNSUPPORTED', total: 1, cells: [{ namespace: 'localizable', key: 'k', locale: 'en', reason: 'exactMatch' }] };
    const client = {
      get: vi.fn(async (path: string) => {
        if (path === '/cli/v1/whoami') return { project: { defaultLocale: 'en' } };
        throw new CliError(6, 'x', body);
      }),
    };

    const failure = (await runPull({}, { cwd: await tmp(), config, api: client as never, out: quiet }).catch((e: unknown) => e)) as CliError;

    expect(failure.exitCode).toBe(6);
    expect(failure.message).toMatch(/Pull refused: 1 translation\(s\) cannot be written as iOS \.strings\/\.stringsdict\. Nothing was written\./);
    expect(failure.message).toMatch(/exact match/);
    expect(failure.message).toContain('one plural (`=0` allowed; no `select`), or move the key to a JSON rule.');
    expect(failure.message).not.toContain('plural/select');
  });
});
