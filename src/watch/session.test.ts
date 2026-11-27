import { describe, expect, it } from 'vitest';

import { CliError, EXIT } from '../errors.js';
import { answer, counts, harness } from './harness.js';

/** Far past the 3 s "young file" window of files written at mtime 0. */
const T: number = 100_000;
const FILES = {
  'locales/en/cart.json': '{"a":"A"}',
  'locales/en/nav.json': '{"home":"Home"}',
  'locales/it/cart.json': '{"a":"A it"}',
};

describe('WatchSession.scan', () => {
  it('the first scan marks every source namespace dirty and ignores target files', async () => {
    const h = await harness(FILES);

    expect((await h.session.scan(T)).sort()).toEqual(['cart', 'nav']);
    expect([...h.session.dirty].sort()).toEqual(['cart', 'nav']);
    expect(h.session.files.map((match) => match.path)).toEqual(['locales/en/cart.json', 'locales/en/nav.json']);
    expect(h.read).not.toHaveBeenCalledWith('locales/it/cart.json');
  });

  it('an untouched file is not read again', async () => {
    const h = await harness(FILES);
    await h.session.scan(T);
    const reads: number = h.read.mock.calls.length;

    expect(await h.session.scan(T + 500)).toEqual([]);
    expect(h.read.mock.calls.length).toBe(reads);
  });

  it('a changed file marks only its namespace', async () => {
    const h = await harness(FILES);
    await h.session.scan(T);
    await h.put('locales/en/cart.json', '{"a":"A","b":"B"}', T);

    expect(await h.session.scan(T + 5000)).toEqual(['cart']);
  });

  it('same bytes with a new mtime is not a change', async () => {
    const h = await harness(FILES);
    await h.session.scan(T);
    await h.put('locales/en/cart.json', '{"a":"A"}', T);

    expect(await h.session.scan(T + 5000)).toEqual([]);
  });

  it('a file younger than 3000 ms is re-hashed even when mtime and size are equal', async () => {
    const h = await harness(FILES);
    await h.put('locales/en/cart.json', '{"a":"A"}', T);
    await h.session.scan(T + 100);
    // A second save inside the file system's mtime granularity: same mtime, same size, other bytes.
    await h.put('locales/en/cart.json', '{"a":"B"}', T);

    expect(await h.session.scan(T + 600)).toEqual(['cart']);
  });

  it('a new source file marks its namespace', async () => {
    const h = await harness(FILES);
    await h.session.scan(T);
    await h.put('locales/en/checkout.json', '{"pay":"Pay"}');

    expect(await h.session.scan(T + 500)).toEqual(['checkout']);
  });

  it('a deleted file marks its namespace when another source file of it remains', async () => {
    const h = await harness(
      { 'en.lproj/Localizable.strings': '"a" = "A";', 'en.lproj/Localizable.stringsdict': '<plist/>' },
      {},
      {
        files: [
          { pattern: '{locale}.lproj/Localizable.strings', format: 'strings', namespace: 'app' },
          { pattern: '{locale}.lproj/Localizable.stringsdict', format: 'stringsdict', namespace: 'app' },
        ],
      },
    );
    await h.session.scan(T);
    await h.remove('en.lproj/Localizable.stringsdict');

    // One miss may be an editor or a checkout between delete and write: it takes two polls.
    expect(await h.session.scan(T + 500)).toEqual([]);
    expect(await h.session.scan(T + 1000)).toEqual(['app']);
    expect(h.session.files.map((match) => match.path)).toEqual(['en.lproj/Localizable.strings']);
  });

  it('a namespace left with no source file is not dirty and says so once', async () => {
    const h = await harness(FILES);
    await h.session.scan(T);
    await h.remove('locales/en/nav.json');

    expect(await h.session.scan(T + 500)).toEqual([]);
    expect(h.out).toEqual([]);
    await h.session.scan(T + 1000);
    await h.session.scan(T + 1500);

    expect([...h.session.dirty]).toEqual(['cart']);
    expect(h.out).toEqual(['12:04:31 nav: no source file left, nothing pushed']);
  });

  it('--namespace narrows the scan', async () => {
    const h = await harness(FILES, { namespace: 'nav' });

    expect(await h.session.scan(T)).toEqual(['nav']);
  });

  it('a rule clash prints once across scans and marks nothing', async () => {
    // Two rules match one path.
    const clash = await harness(
      FILES,
      {},
      {
        files: [
          { pattern: 'locales/{locale}/{namespace}.json', format: 'json', jsonStyle: 'nested' },
          { pattern: 'locales/{locale}/cart.json', format: 'json', jsonStyle: 'nested', namespace: 'cart' },
        ],
      },
    );

    expect(await clash.session.scan(T)).toEqual([]);
    await clash.session.scan(T + 500);
    await clash.session.scan(T + 1000);

    expect(clash.err).toEqual(['12:04:31 locales/en/cart.json is matched by more than one files rule.']);
    expect([...clash.session.dirty]).toEqual([]);
    expect(clash.session.problem).toBe('locales/en/cart.json is matched by more than one files rule.');
  });

  it('a clash that appears mid-watch skips the push, and prints again after it was fixed and came back', async () => {
    const h = await harness(FILES);
    await h.session.tick(T, true);
    h.post.mockClear();
    const clash = async (on: boolean, at: number): Promise<void> => {
      // `english/` aliased to en makes two files claim en/cart.
      if (on) await h.put('locales/english/cart.json', '{"a":"dup"}', at);
      else await h.remove('locales/english/cart.json');
    };
    await h.put('locales/en/cart.json', '{"a":"new"}', T + 1000);
    await h.session.tick(T + 1000);
    await clash(true, T + 1500);

    expect(await h.session.tick(T + 9000)).toBe('continue');
    expect(h.post).not.toHaveBeenCalled();
    expect(h.err).toHaveLength(1);
    expect(h.err[0]).toContain('both map to locale en, namespace cart');

    await clash(false, 0);
    await h.session.tick(T + 9500);
    expect(h.session.problem).toBeUndefined();
    expect(h.post).toHaveBeenCalledTimes(1);

    await clash(true, T + 10_000);
    await h.session.tick(T + 10_500);
    expect(h.err).toHaveLength(2);
  });

  it('an error from the file system during the glob is reported once and the watch goes on', async () => {
    const h = await harness(FILES);
    await h.session.scan(T);
    h.fail.glob = Object.assign(new Error("EACCES: permission denied, scandir 'locales/en'"), { code: 'EACCES' });

    expect(await h.session.tick(T + 500)).toBe('continue');
    expect(await h.session.tick(T + 1000)).toBe('continue');
    expect(h.err).toEqual(["12:04:31 Could not list the project files: EACCES: permission denied, scandir 'locales/en'"]);

    h.fail.glob = undefined;
    expect(await h.session.tick(T + 1500, true)).toBe('continue');
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it('a source file that cannot be read is named once, and pushed when it can be', async () => {
    const h = await harness(FILES);
    h.fail.read.add('locales/en/nav.json');

    await h.session.tick(T, true);
    await h.session.tick(T + 500);
    expect(h.err).toEqual(['12:04:31 locales/en/nav.json cannot be read (ENOENT); it is not pushed until it can be.']);
    expect(h.post).toHaveBeenCalledTimes(1);

    h.fail.read.clear();
    h.out.length = 0;
    await h.session.tick(T + 1000);
    expect(h.out).toEqual(['12:04:31 locales/en/nav.json can be read again.']);
    await h.session.tick(T + 3100);
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.manifest(1)[0]!.namespace).toBe('nav');
  });

  it('a file deleted and written back with the same bytes pushes nothing and prints nothing', async () => {
    const h = await harness(FILES);
    await h.session.tick(T, true);
    h.post.mockClear();
    h.out.length = 0;
    await h.remove('locales/en/nav.json');
    await h.session.tick(T + 500);
    await h.session.tick(T + 1000);
    await h.put('locales/en/nav.json', '{"home":"Home"}', T + 1200);
    await h.session.tick(T + 1500);
    await h.session.tick(T + 9000);

    expect(h.post).not.toHaveBeenCalled();
    expect(h.out).toEqual(['12:04:31 nav: no source file left, nothing pushed']);
  });
});

describe('WatchSession.tick', () => {
  const refusal = (status: number | undefined, code: string, message: string = code): CliError =>
    new CliError(status === 402 ? EXIT.quota : status === 401 ? EXIT.auth : EXIT.failed, message, { code }, status);
  /** Started and settled: the first tick has pushed everything. */
  const started = async (files: Record<string, string> = FILES) => {
    const h = await harness(files);
    expect(await h.session.tick(T, true)).toBe('continue');
    h.post.mockClear();
    h.get.mockClear();
    h.out.length = 0;

    return h;
  };

  it('the first tick pushes every namespace at once, one request each in name order, with one summary line', async () => {
    const h = await harness(FILES);

    expect(await h.session.tick(T, true)).toBe('continue');

    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.post.mock.calls[0]![0]).toBe('/cli/v1/push');
    expect(h.manifest(0).map((file) => file.path)).toEqual(['locales/en/cart.json']);
    expect(h.manifest(1).map((file) => file.path)).toEqual(['locales/en/nav.json']);
    expect(h.out).toEqual(['12:04:31 pushed 2 namespace(s): 0 created, 0 updated, 2 unchanged']);
    expect([...h.session.dirty]).toEqual([]);
  });

  it('a change is pushed only after the quiet period, and only its namespace', async () => {
    const h = await started();
    await h.put('locales/en/cart.json', '{"a":"A","b":"B"}', T + 1000);
    h.post.mockResolvedValue(answer({ locales: { en: counts({ created: 1, unchanged: 1 }) } }));

    await h.session.tick(T + 1000);
    await h.session.tick(T + 2500);
    expect(h.post).not.toHaveBeenCalled();

    await h.session.tick(T + 3100);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.manifest(0)).toEqual([expect.objectContaining({ path: 'locales/en/cart.json', namespace: 'cart', locale: 'en' })]);
    expect(h.flag(0, 'dryRun')).toBe('false');
    expect(h.flag(0, 'prune')).toBe('false');
    expect(h.flag(0, 'overwriteTargets')).toBe('false');
    expect(h.out).toEqual(['12:04:31 cart: 1 created']);
  });

  it('two saves inside the quiet period make one push, counted from the last save', async () => {
    const h = await started();
    await h.put('locales/en/cart.json', '{"a":"1"}', T + 1000);
    await h.session.tick(T + 1000);
    await h.put('locales/en/cart.json', '{"a":"2"}', T + 2500);
    await h.session.tick(T + 2500);
    await h.session.tick(T + 3100);
    expect(h.post).not.toHaveBeenCalled();

    await h.session.tick(T + 4600);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('bytes changed and changed back send nothing', async () => {
    const h = await started();
    await h.put('locales/en/cart.json', '{"a":"typo"}', T + 1000);
    await h.session.tick(T + 1000);
    await h.put('locales/en/cart.json', '{"a":"A"}', T + 1500);
    await h.session.tick(T + 1500);

    await h.session.tick(T + 9000);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.out).toEqual([]);
    expect([...h.session.dirty]).toEqual([]);
  });

  it('the request carries every source file of the namespace and the status flag', async () => {
    const h = await harness(
      { 'en.lproj/Localizable.strings': '"a" = "A";', 'en.lproj/Localizable.stringsdict': '<plist/>' },
      { status: 'draft' },
      {
        files: [
          { pattern: '{locale}.lproj/Localizable.strings', format: 'strings', namespace: 'app' },
          { pattern: '{locale}.lproj/Localizable.stringsdict', format: 'stringsdict', namespace: 'app' },
        ],
      },
    );

    await h.session.tick(T, true);

    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.manifest(0).map((file) => file.path)).toEqual(['en.lproj/Localizable.strings', 'en.lproj/Localizable.stringsdict']);
    expect(h.flag(0, 'status')).toBe('DRAFT');
  });

  it('a Rails rule with a locale alias sends the disk locale as fileLocale, as a plain push does', async () => {
    const h = await harness(
      { 'config/locales/en-GB.yml': 'en-GB:\n  hello: Hello\n', 'config/locales/it.yml': 'it:\n  hello: Ciao\n' },
      {},
      {
        files: [{ pattern: 'config/locales/{locale}.yml', format: 'yaml', yamlDialect: 'rails', namespace: 'app' }],
        locales: { 'en-GB': 'en' },
      },
    );

    expect(await h.session.tick(T, true)).toBe('continue');

    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.manifest(0)).toEqual([
      { field: 'file0', path: 'config/locales/en-GB.yml', format: 'yaml', locale: 'en', namespace: 'app', dialect: 'rails', fileLocale: 'en-GB' },
    ]);
  });

  it('a 422 prints, lets the other namespace go, and is not sent again until the file changes', async () => {
    const h = await harness(FILES);
    h.post.mockRejectedValueOnce(refusal(422, 'VALIDATION_FAILED', 'The push was rejected; nothing was written.\nlocales/en/cart.json:1: syntax'));

    expect(await h.session.tick(T, true)).toBe('continue');

    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.err).toEqual(['12:04:31 cart: The push was rejected; nothing was written.\n         locales/en/cart.json:1: syntax']);
    expect(h.out).toEqual(['12:04:31 pushed 1 namespace(s): 0 created, 0 updated, 1 unchanged']);

    await h.session.tick(T + 10_000);
    await h.session.tick(T + 60_000);
    expect(h.post).toHaveBeenCalledTimes(2);

    // The next save of that file retries it.
    await h.put('locales/en/cart.json', '{"a":"fixed"}', T + 61_000);
    await h.session.tick(T + 61_000);
    await h.session.tick(T + 63_100);
    expect(h.post).toHaveBeenCalledTimes(3);
    expect(h.manifest(2)[0]!.namespace).toBe('cart');
  });

  it('a network error keeps the namespace dirty and retries after 2, 5, 15 then 30 s', async () => {
    const h = await started();
    await h.put('locales/en/cart.json', '{"a":"new"}', T);
    await h.session.tick(T + 5000);
    h.post.mockRejectedValue(new CliError(EXIT.network, 'Could not reach https://x/api.'));

    let now: number = T + 8000;
    await h.session.tick(now);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.err).toEqual(['12:04:31 cart: Could not reach https://x/api. Retrying in 2 s.']);

    for (const [wait, calls] of [[2000, 2], [5000, 3], [15_000, 4], [30_000, 5], [30_000, 6]] as const) {
      await h.session.tick(now + wait - 1);
      expect(h.post).toHaveBeenCalledTimes(calls - 1);
      now += wait;
      await h.session.tick(now);
      expect(h.post).toHaveBeenCalledTimes(calls);
    }
    expect([...h.session.dirty]).toEqual(['cart']);

    h.post.mockResolvedValue(answer());
    await h.session.tick(now + 30_000);
    expect([...h.session.dirty]).toEqual([]);
  });

  it('a new save during the backoff starts over with the quiet period', async () => {
    const h = await started();
    await h.put('locales/en/cart.json', '{"a":"new"}', T);
    await h.session.tick(T + 5000);
    h.post.mockRejectedValueOnce(new CliError(EXIT.network, 'down')).mockRejectedValueOnce(new CliError(EXIT.network, 'down'));
    await h.session.tick(T + 8000);
    await h.session.tick(T + 10_000);
    expect(h.post).toHaveBeenCalledTimes(2);

    // Next retry would be 5 s later; a save in between pushes after 2 s of quiet instead.
    await h.put('locales/en/cart.json', '{"a":"newer"}', T + 11_000);
    await h.session.tick(T + 11_000);
    await h.session.tick(T + 13_000);
    expect(h.post).toHaveBeenCalledTimes(3);
  });

  it('a 409 is retried like a network error', async () => {
    const h = await harness(FILES);
    h.post.mockRejectedValueOnce(refusal(409, 'TRANSACTION_CONFLICT', 'The server hit a transaction conflict. Try again.'));

    expect(await h.session.tick(T, true)).toBe('continue');
    // A namespace that keeps failing never holds back the next one.
    expect(h.post).toHaveBeenCalledTimes(2);
    expect([...h.session.dirty]).toEqual(['cart']);
    expect(h.out).toEqual(['12:04:31 pushed 1 namespace(s): 0 created, 0 updated, 1 unchanged']);

    await h.session.tick(T + 1999);
    expect(h.post).toHaveBeenCalledTimes(2);
    await h.session.tick(T + 2000);
    expect(h.post).toHaveBeenCalledTimes(3);
    expect(h.manifest(2)[0]!.namespace).toBe('cart');
  });

  it('a namespace that fails every time does not starve the others, and its backoff still grows', async () => {
    const h = await started();
    h.post.mockImplementation(async (_path: string, form: FormData) => {
      if ((form.get('manifest') as string).includes('"namespace":"cart"')) throw new CliError(EXIT.network, 'down');

      return answer();
    });
    await h.put('locales/en/cart.json', '{"a":"1"}', T);
    await h.put('locales/en/nav.json', '{"home":"1"}', T);
    await h.session.tick(T + 1000);
    await h.session.tick(T + 5000);
    const pushes = (namespace: string): number =>
      h.post.mock.calls.filter(([, form]) => ((form as FormData).get('manifest') as string).includes(`"namespace":"${namespace}"`)).length;
    expect([pushes('cart'), pushes('nav')]).toEqual([1, 1]);

    // cart is retried 2 s later, then 5 s after that: nav going through did not reset its backoff.
    await h.session.tick(T + 7000);
    expect(pushes('cart')).toBe(2);
    await h.session.tick(T + 11_999);
    expect(pushes('cart')).toBe(2);
    await h.session.tick(T + 12_000);
    expect(pushes('cart')).toBe(3);
  });

  it('the retry line stops repeating once the backoff has reached 30 s', async () => {
    const h = await started();
    h.post.mockRejectedValue(new CliError(EXIT.network, 'down'));
    await h.put('locales/en/cart.json', '{"a":"1"}', T);
    await h.session.tick(T + 1000);
    let now: number = T + 5000;
    for (const wait of [0, 2000, 5000, 15_000, 30_000, 30_000, 30_000]) {
      now += wait;
      await h.session.tick(now);
    }

    expect(h.post).toHaveBeenCalledTimes(7);
    expect(h.err).toEqual([
      '12:04:31 cart: down Retrying in 2 s.',
      '12:04:31 cart: down Retrying in 5 s.',
      '12:04:31 cart: down Retrying in 15 s.',
      '12:04:31 cart: down Retrying every 30 s.',
    ]);
  });

  it('a change during a push is pushed after it', async () => {
    const h = await started();
    await h.put('locales/en/cart.json', '{"a":"1"}', T);
    h.post.mockImplementationOnce(async () => {
      // Saved again while the request is on its way.
      await h.put('locales/en/cart.json', '{"a":"2"}', T + 5001);

      return answer();
    });
    await h.session.tick(T + 1000);
    await h.session.tick(T + 5000);
    expect(h.post).toHaveBeenCalledTimes(1);

    await h.session.tick(T + 5500);
    await h.session.tick(T + 7600);
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it('an answer without locales prints unchanged instead of throwing', async () => {
    const h = await harness(FILES);
    h.post.mockResolvedValue({ dryRun: false });

    expect(await h.session.tick(T, true)).toBe('continue');
    expect(h.out).toEqual(['12:04:31 pushed 2 namespace(s): 0 created, 0 updated, 0 unchanged']);
  });

  it('nothing is sent once a stop was asked for, and a failure then promises no retry', async () => {
    const h = await harness(FILES);
    h.stopping.value = true;
    expect(await h.session.tick(T, true)).toBe('continue');
    expect(h.get).not.toHaveBeenCalled();

    const late = await harness(FILES);
    late.post.mockImplementationOnce(async () => {
      late.stopping.value = true;
      throw new CliError(EXIT.network, 'down');
    });
    await late.session.tick(T, true);
    expect(late.err).toEqual(['12:04:31 cart: down']);
  });

  it('a 401 returns the auth exit code and starts no further request', async () => {
    const h = await harness(FILES);
    h.post.mockRejectedValueOnce(refusal(401, 'KEY_REVOKED', 'This key was revoked. Create a new secret key in Translify.'));

    expect(await h.session.tick(T, true)).toBe(EXIT.auth);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.err).toEqual(['12:04:31 This key was revoked. Create a new secret key in Translify.']);
  });

  it('a 402 prints and waits for the next save', async () => {
    const h = await harness(FILES);
    h.post.mockRejectedValueOnce(refusal(402, 'QUOTA_EXCEEDED', 'Plan limit reached'));

    expect(await h.session.tick(T, true)).toBe('continue');
    await h.session.tick(T + 60_000);

    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.err).toEqual(['12:04:31 cart: Plan limit reached']);
  });

  it('whoami failing with a network error backs off; with a 401 it ends the watch', async () => {
    const h = await harness(FILES);
    h.get.mockRejectedValueOnce(new CliError(EXIT.network, 'Could not reach https://x/api.'));

    expect(await h.session.tick(T, true)).toBe('continue');
    expect(h.post).not.toHaveBeenCalled();
    expect(h.err).toEqual(['12:04:31 Could not reach https://x/api. Retrying in 2 s.']);

    h.get.mockRejectedValueOnce(refusal(401, 'KEY_INVALID', 'The key was not recognised.'));
    expect(await h.session.tick(T + 2000)).toBe(EXIT.auth);
    expect(h.post).not.toHaveBeenCalled();
  });

  it('a changed default locale ends the watch with exit 1 before any push', async () => {
    const h = await harness(FILES);
    h.get.mockResolvedValue({ project: { defaultLocale: 'it' } });

    expect(await h.session.tick(T, true)).toBe(EXIT.failed);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.err).toEqual(["12:04:31 The project's default locale changed from en to it; stopping. Run translify push --watch again."]);
  });

  it('a file that vanishes between scan and push does not throw; its next appearance is pushed', async () => {
    const h = await started();
    await h.put('locales/en/cart.json', '{"a":"new"}', T);
    await h.session.tick(T + 5000);
    // Unreadable at push time only: the scan of that tick still hashes it.
    const real = h.read.getMockImplementation()!;
    let failures: number = 0;
    h.read.mockImplementation(async (path: string) => {
      if (path === 'locales/en/cart.json' && h.session.dirty.has('cart') && failures === 0 && h.get.mock.calls.length > 0) {
        failures += 1;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }

      return real(path);
    });

    expect(await h.session.tick(T + 8000)).toBe('continue');
    expect(failures).toBe(1);
    expect(h.post).not.toHaveBeenCalled();

    // Same bytes as the scan saw before: it must still go up once readable again.
    await h.session.tick(T + 8500);
    await h.session.tick(T + 11_000);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('the orphan note prints when the count changes, not on every push', async () => {
    const h = await started();
    const orphans = [{ namespace: 'cart', key: 'old' }, { namespace: 'cart', key: 'older' }];
    h.post.mockResolvedValue(answer({ orphans }));
    const save = async (at: number, text: string): Promise<void> => {
      await h.put('locales/en/cart.json', text, at);
      await h.session.tick(at);
      await h.session.tick(at + 2000);
    };

    await save(T + 10_000, '{"a":"1"}');
    await save(T + 20_000, '{"a":"2"}');
    h.post.mockResolvedValue(answer({ orphans: [orphans[0]!] }));
    await save(T + 30_000, '{"a":"3"}');
    h.post.mockResolvedValue(answer());
    await save(T + 40_000, '{"a":"4"}');

    expect(h.out.filter((line) => line.includes('not in your source files'))).toEqual([
      '         2 key(s) in Translify are not in your source files (cart). Run translify push --prune when done.',
      '         1 key(s) in Translify are not in your source files (cart). Run translify push --prune when done.',
    ]);
  });

  it('warnings and the stale reset follow the push line, indented', async () => {
    const h = await started();
    h.post.mockResolvedValue(answer({ locales: { en: counts({ updated: 1 }) }, warnings: ['locales/en/cart.json: odd'], staleReset: 2 }));
    await h.put('locales/en/cart.json', '{"a":"new"}', T);
    await h.session.tick(T + 5000);
    await h.session.tick(T + 8000);

    expect(h.out).toEqual([
      '12:04:31 cart: 1 updated',
      '         warning: locales/en/cart.json: odd',
      '         2 approved translation(s) went back to review because their source text changed.',
    ]);
  });

  it('stopping mid-pass: the request in flight completes, the next namespace is not sent', async () => {
    const h = await harness(FILES);
    h.post.mockImplementationOnce(async () => {
      h.stopping.value = true;

      return answer();
    });

    expect(await h.session.tick(T, true)).toBe('continue');
    expect(h.post).toHaveBeenCalledTimes(1);
    expect([...h.session.dirty]).toEqual(['nav']);
  });
});
