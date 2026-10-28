import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectAndroid } from './android.js';

const RES: string = '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n';

const tree = async (files: Record<string, string>): Promise<string> => {
  const root: string = await mkdtemp(join(tmpdir(), 'tfy-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }

  return root;
};

const rule = (name: string, namespace: string, dir: string = 'app/src/main/res') => ({
  pattern: `${dir}/values-{locale}/${name}.xml`,
  format: 'android',
  namespace,
});

describe('detectAndroid', () => {
  it('ignores a repo without res/values', async () => {
    expect(await detectAndroid(await tree({ 'package.json': '{}' }))).toEqual({ rules: [], notes: [] });
  });

  it('proposes one rule per resources file and skips donottranslate.xml', async () => {
    const cwd: string = await tree({
      'app/src/main/res/values/strings.xml': RES,
      'app/src/main/res/values/plurals.xml': RES,
      'app/src/main/res/values/donottranslate.xml': RES,
    });

    expect(await detectAndroid(cwd)).toEqual({
      rules: [rule('plurals', 'plurals'), rule('strings', 'strings')],
      notes: [],
    });
  });

  it('kebab-cases the namespace', async () => {
    const cwd: string = await tree({ 'app/src/main/res/values/my_Strings.xml': RES });

    expect((await detectAndroid(cwd)).rules[0]?.namespace).toBe('my-strings');
  });

  it('skips files whose root is not <resources>, and build output', async () => {
    const cwd: string = await tree({
      'app/src/main/res/values/strings.xml': RES,
      'app/src/main/res/values/colors.xml': '<?xml version="1.0"?>\n<!-- c -->\n<other/>',
      'app/build/intermediates/res/values/strings.xml': RES,
    });

    expect((await detectAndroid(cwd)).rules).toEqual([rule('strings', 'strings')]);
  });

  it('notes when two modules hold a values/ dir', async () => {
    const cwd: string = await tree({
      'app/src/main/res/values/strings.xml': RES,
      'lib/src/main/res/values/strings.xml': RES,
    });
    const found = await detectAndroid(cwd);

    expect(found.rules).toHaveLength(2);
    expect(found.notes).toHaveLength(1);
    expect(found.notes[0]).toMatch(/app\/src\/main\/res.*lib\/src\/main\/res|Two modules/);
  });
});
