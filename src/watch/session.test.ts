import { describe, expect, it } from 'vitest';

import { harness } from './harness.js';

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

    expect(await h.session.scan(T + 500)).toEqual(['app']);
    expect(h.session.files.map((match) => match.path)).toEqual(['en.lproj/Localizable.strings']);
  });

  it('a namespace left with no source file is not dirty and says so once', async () => {
    const h = await harness(FILES);
    await h.session.scan(T);
    await h.remove('locales/en/nav.json');

    expect(await h.session.scan(T + 500)).toEqual([]);
    await h.session.scan(T + 1000);

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
  });
});
