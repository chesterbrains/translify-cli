import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config.js';
import { CliError, EXIT } from '../errors.js';
import { runInit, type InitDeps, type WhoamiInfo } from './init.js';

const tree = async (files: Record<string, string>): Promise<string> => {
  const root: string = await mkdtemp(join(tmpdir(), 'tfy-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
};

const WHOAMI: WhoamiInfo = {
  project: { name: 'Acme', slug: 'acme', defaultLocale: 'en-US' },
  key: { scopes: ['PULL', 'PUSH'] },
  locales: ['en-US', 'it-IT'],
};
const SAVED: string = '/home/me/.config/translify/credentials';
const PROMPT: InitDeps['prompt'] = {
  input: async (_m, def) => def,
  confirm: async () => true,
  checkbox: async (_m, options) => options,
  secret: async () => '',
};

const deps = (cwd: string, over: Partial<InitDeps> = {}): { d: InitDeps; out: string[] } => {
  const out: string[] = [];
  const d: InitDeps = {
    cwd,
    isTty: true,
    yes: false,
    apiUrlDefault: 'https://example.test/api',
    out: (line) => out.push(line),
    prompt: PROMPT,
    findKey: async () => undefined,
    saveKey: async () => SAVED,
    fetchWhoami: async () => WHOAMI,
    ...over,
  };

  return { d, out };
};

const written = async (cwd: string): Promise<string> => readFile(join(cwd, 'translify.json'), 'utf8');
const notWritten = async (cwd: string): Promise<void> => expect(written(cwd)).rejects.toThrow();
const rejected = (): CliError => new CliError(EXIT.auth, 'Secret key invalid.');

describe('runInit: output file', () => {
  it('writes a translify.json that loadConfig accepts, with $schema and no key', async () => {
    const cwd: string = await tree({ 'public/locales/en/common.json': '{}' });

    expect(await runInit(deps(cwd).d)).toBe(0);
    const raw: string = await written(cwd);
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw).$schema).toBe('https://unpkg.com/@chesterbrains/translify-cli/schema/translify.schema.json');
    expect(raw).not.toMatch(/key|secret|token/i);
    await expect(loadConfig(cwd)).resolves.toEqual({
      apiUrl: 'https://example.test/api',
      files: [{ pattern: 'public/locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' }],
      locales: {},
    });
  });

  it('prints the exact bytes it writes, and prints detection notes', async () => {
    const cwd: string = await tree({ 'angular.json': JSON.stringify({ projects: { app: { i18n: { locales: { it: 'src/locale/messages.it.xlf' } } } } }) });
    const { d, out } = deps(cwd);

    expect(await runInit(d)).toBe(0);
    const raw: string = await written(cwd);
    expect(out.join('\n')).toContain(raw.trimEnd());
    expect(out.join('\n')).toContain('ng extract-i18n');
  });

  it('still writes a valid file with an example rule when nothing is detected', async () => {
    const cwd: string = await tree({ 'README.md': '' });
    const { d, out } = deps(cwd);

    expect(await runInit(d)).toBe(0);
    await expect(loadConfig(cwd)).resolves.toMatchObject({ files: [expect.any(Object)] });
    expect(out.join('\n')).toMatch(/No i18next, Flutter, Angular, Xcode, Android or iOS \(\.lproj\) layout found/);
  });

  it('writes nothing when the preview is declined', async () => {
    const cwd: string = await tree({ 'locales/en/a.json': '{}' });
    const confirm = vi.fn(async (message: string) => !/Write translify\.json/.test(message));
    const { d, out } = deps(cwd, { prompt: { ...PROMPT, confirm } });

    expect(await runInit(d)).toBe(1);
    expect(confirm).toHaveBeenCalledWith('Write translify.json?', true);
    expect(out.at(-1)).toBe('Nothing was written.');
    await notWritten(cwd);
  });

  it('rejects a bad apiUrl and writes nothing', async () => {
    const cwd: string = await tree({ 'locales/en/a.json': '{}' });
    const { d } = deps(cwd, { prompt: { ...PROMPT, input: async () => 'not a url' } });

    expect(await runInit(d)).toBe(1);
    await notWritten(cwd);
  });

  it('takes --api-url without prompting and validates it', async () => {
    const cwd: string = await tree({ 'locales/en/a.json': '{}' });
    const input = vi.fn();
    expect(await runInit(deps(cwd, { apiUrl: 'https://custom.test/api', prompt: { ...PROMPT, input } }).d)).toBe(0);
    expect(input).not.toHaveBeenCalled();
    await expect(loadConfig(cwd)).resolves.toMatchObject({ apiUrl: 'https://custom.test/api' });

    const bad: string = await tree({ 'locales/en/a.json': '{}' });
    expect(await runInit(deps(bad, { apiUrl: 'ftp://x' }).d)).toBe(1);
    await notWritten(bad);
  });
});

describe('runInit: existing file', () => {
  it('refuses to overwrite without confirmation', async () => {
    const cwd: string = await tree({ 'translify.json': 'KEEP', 'locales/en/a.json': '{}' });
    const confirm = vi.fn().mockResolvedValue(false);
    const { d } = deps(cwd, { prompt: { ...PROMPT, confirm } });

    expect(await runInit(d)).toBe(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/overwrite/i), false);
    expect(await written(cwd)).toBe('KEEP');
  });

  it('overwrites when confirmed', async () => {
    const cwd: string = await tree({ 'translify.json': 'KEEP', 'locales/en/a.json': '{}' });

    expect(await runInit(deps(cwd).d)).toBe(0);
    await expect(loadConfig(cwd)).resolves.toBeDefined();
  });

  it('never overwrites under --yes, and stops before any prompt or request', async () => {
    const cwd: string = await tree({ 'translify.json': 'KEEP', 'locales/en/a.json': '{}' });
    const fetchWhoami = vi.fn();
    const confirm = vi.fn();
    const { d, out } = deps(cwd, { yes: true, fetchWhoami, prompt: { ...PROMPT, confirm } });

    expect(await runInit(d)).toBe(1);
    expect(out.join('\n')).toContain('translify.json already exists. Delete it first.');
    expect(fetchWhoami).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(await written(cwd)).toBe('KEEP');
  });
});

describe('runInit: key', () => {
  it('uses a stored key silently and prints the project line', async () => {
    const cwd: string = await tree({ 'locales/en_US/common.json': '{}', 'locales/it-IT/common.json': '{}' });
    const fetchWhoami = vi.fn().mockResolvedValue(WHOAMI);
    const secret = vi.fn();
    const saveKey = vi.fn();
    const { d, out } = deps(cwd, { findKey: async () => 'sk_stored', fetchWhoami, saveKey, prompt: { ...PROMPT, secret } });

    expect(await runInit(d)).toBe(0);
    expect(fetchWhoami).toHaveBeenCalledWith('https://example.test/api', 'sk_stored');
    expect(secret).not.toHaveBeenCalled();
    expect(saveKey).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/Project: Acme, default locale en-US; locales: en-US, it-IT/);
    await expect(loadConfig(cwd)).resolves.toMatchObject({ locales: { en_US: 'en-US' } });
  });

  it('asks for a key when none is stored, checks it, saves it, never echoes it', async () => {
    const cwd: string = await tree({ 'locales/en/common.json': '{}' });
    const fetchWhoami = vi.fn().mockResolvedValue(WHOAMI);
    const saveKey = vi.fn().mockResolvedValue(SAVED);
    const { d, out } = deps(cwd, { fetchWhoami, saveKey, prompt: { ...PROMPT, secret: async () => '  sk_typedvalue \n' } });

    expect(await runInit(d)).toBe(0);
    expect(fetchWhoami).toHaveBeenCalledWith('https://example.test/api', 'sk_typedvalue');
    expect(saveKey).toHaveBeenCalledWith('sk_typedvalue');
    const text: string = out.join('\n');
    expect(text).toContain(`Logged in to Acme (acme) with scopes PULL, PUSH. Saved to ${SAVED}.`);
    expect(text).not.toContain('sk_typedvalue');
    expect(text).toContain('Wrote translify.json.');
    expect(text).not.toContain('run `translify login`');
    // The suggested map came from whoami.
    await expect(loadConfig(cwd)).resolves.toMatchObject({ locales: { en: 'en-US' } });
  });

  it('skips whoami on an empty key, saves nothing, and still writes the config', async () => {
    const cwd: string = await tree({ 'locales/en/common.json': '{}' });
    const fetchWhoami = vi.fn();
    const saveKey = vi.fn();
    const { d, out } = deps(cwd, { fetchWhoami, saveKey });

    expect(await runInit(d)).toBe(0);
    expect(fetchWhoami).not.toHaveBeenCalled();
    expect(saveKey).not.toHaveBeenCalled();
    expect(out.at(-1)).toMatch(/run `translify login` or set TRANSLIFY_SECRET_KEY/);
    await expect(loadConfig(cwd)).resolves.toMatchObject({ locales: {} });
  });

  it('throws exit 2 on a rejected typed key, saving and writing nothing', async () => {
    const cwd: string = await tree({ 'locales/en/common.json': '{}' });
    const saveKey = vi.fn();
    const { d } = deps(cwd, { fetchWhoami: async () => Promise.reject(rejected()), saveKey, prompt: { ...PROMPT, secret: async () => 'sk_bad' } });

    await expect(runInit(d)).rejects.toMatchObject({ exitCode: 2 });
    expect(saveKey).not.toHaveBeenCalled();
    await notWritten(cwd);
  });

  it('refuses a pk_ or malformed typed key before any request', async () => {
    for (const typed of ['pk_public', 'sk_…', 'garbage']) {
      const cwd: string = await tree({ 'locales/en/common.json': '{}' });
      const fetchWhoami = vi.fn();
      const { d } = deps(cwd, { fetchWhoami, prompt: { ...PROMPT, secret: async () => typed } });

      await expect(runInit(d)).rejects.toMatchObject({ exitCode: 2 });
      expect(fetchWhoami).not.toHaveBeenCalled();
      await notWritten(cwd);
    }
  });

  it('warns and continues when the stored key is rejected or the server is unreachable', async () => {
    const cwd: string = await tree({ 'locales/en/common.json': '{}' });
    const { d, out } = deps(cwd, { findKey: async () => 'sk_stored', fetchWhoami: async () => Promise.reject(rejected()) });
    expect(await runInit(d)).toBe(0);
    expect(out.join('\n')).toContain('Stored key was rejected; run `translify login`. Continuing without project info.');
    await expect(loadConfig(cwd)).resolves.toMatchObject({ locales: {} });

    const down: string = await tree({ 'locales/en/common.json': '{}' });
    const net = deps(down, { findKey: async () => 'sk_stored', fetchWhoami: async () => Promise.reject(new CliError(EXIT.network, 'Could not connect.')) });
    expect(await runInit(net.d)).toBe(0);
    expect(net.out.join('\n')).toContain('Could not reach Translify (Could not connect.). Continuing without project info.');
  });

  it('propagates a malformed stored key (exit 2) and writes nothing, also under --yes', async () => {
    const cwd: string = await tree({ 'locales/en/common.json': '{}' });
    const findKey = async (): Promise<string> => Promise.reject(new CliError(EXIT.auth, 'The key has characters a secret key never has.'));

    await expect(runInit(deps(cwd, { findKey }).d)).rejects.toMatchObject({ exitCode: 2 });
    await expect(runInit(deps(cwd, { findKey, yes: true }).d)).rejects.toMatchObject({ exitCode: 2 });
    await notWritten(cwd);
  });
});

describe('runInit: several layouts', () => {
  it('offers a multi-select with every rule and prints what was dropped', async () => {
    const cwd: string = await tree({ 'locales/en/common.json': '{}', 'public/locales/fr/common.json': '{}' });
    const checkbox = vi.fn().mockResolvedValue(['public/locales/{locale}/{namespace}.json']);
    const { d, out } = deps(cwd, { prompt: { ...PROMPT, checkbox } });

    expect(await runInit(d)).toBe(0);
    expect(checkbox).toHaveBeenCalledWith('Which layouts hold your translations?', [
      'locales/{locale}/{namespace}.json',
      'public/locales/{locale}/{namespace}.json',
    ]);
    expect(out.join('\n')).toMatch(/Dropped: locales\/\{locale\}/);
    await expect(loadConfig(cwd)).resolves.toMatchObject({ files: [{ pattern: 'public/locales/{locale}/{namespace}.json' }] });
  });

  it('keeps every rule when all stay checked, and fails when none is', async () => {
    const both: string = await tree({ 'locales/en/common.json': '{}', 'lib/l10n/app_en.arb': '{}' });
    expect(await runInit(deps(both).d)).toBe(0);
    await expect(loadConfig(both)).resolves.toMatchObject({ files: [{ format: 'json' }, { format: 'arb' }] });

    const none: string = await tree({ 'locales/en/common.json': '{}', 'lib/l10n/app_en.arb': '{}' });
    const { d, out } = deps(none, { prompt: { ...PROMPT, checkbox: async () => [] } });
    expect(await runInit(d)).toBe(1);
    expect(out.at(-1)).toBe('Nothing selected. Nothing was written.');
    await notWritten(none);
  });

  it('labels dialect rules with their dialect', async () => {
    const cwd: string = await tree({ 'locales/en/common.json': '{}', 'App/Localizable.xcstrings': '{}' });
    const checkbox = vi.fn(async (_m: string, options: string[]) => options);
    expect(await runInit(deps(cwd, { prompt: { ...PROMPT, checkbox } }).d)).toBe(0);
    expect(checkbox.mock.calls[0]?.[1]).toEqual(['locales/{locale}/{namespace}.json', 'Localization/{locale}.xliff (xcode)']);
  });
});

describe('runInit: --yes', () => {
  it('writes with no prompt, no TTY, every rule and the suggested map', async () => {
    const cwd: string = await tree({ 'locales/en/common.json': '{}', 'lib/l10n/app_en.arb': '{}' });
    const prompt: InitDeps['prompt'] = { input: vi.fn(), confirm: vi.fn(), checkbox: vi.fn(), secret: vi.fn() };
    const { d, out } = deps(cwd, { yes: true, isTty: false, prompt, findKey: async () => 'sk_stored' });

    expect(await runInit(d)).toBe(0);
    for (const fn of Object.values(prompt)) expect(fn).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('"$schema"');
    await expect(loadConfig(cwd)).resolves.toMatchObject({
      apiUrl: 'https://example.test/api',
      files: [{ format: 'json' }, { format: 'arb' }],
      locales: { en: 'en-US' },
    });
  });

  it('skips whoami under --yes when there is no key', async () => {
    const cwd: string = await tree({ 'locales/en/common.json': '{}' });
    const fetchWhoami = vi.fn();
    const { d, out } = deps(cwd, { yes: true, fetchWhoami });

    expect(await runInit(d)).toBe(0);
    expect(fetchWhoami).not.toHaveBeenCalled();
    expect(out.at(-1)).toMatch(/TRANSLIFY_SECRET_KEY/);
  });

  it('needs a TTY without --yes, names the flag, and does not prompt', async () => {
    const cwd: string = await tree({});
    const input = vi.fn();
    const { d, out } = deps(cwd, { isTty: false, prompt: { ...PROMPT, input } });

    expect(await runInit(d)).toBe(1);
    expect(input).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('Pass `--yes`');
    await notWritten(cwd);
  });
});
