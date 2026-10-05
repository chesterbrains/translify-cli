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
