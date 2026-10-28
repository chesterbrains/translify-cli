import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import fg from 'fast-glob';

import type { FileRule } from '../config.js';
import { kebab, NONE, type Detection } from './shared.js';

const IGNORE: string[] = ['**/build/**', '**/node_modules/**', '**/.git/**'];
const RESOURCES_ROOT: RegExp = /^(?:\s|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)*<resources[\s>/]/;

const isResources = async (cwd: string, path: string): Promise<boolean> =>
  RESOURCES_ROOT.test((await readFile(join(cwd, path), 'utf8').catch(() => '')).replace(/^\u{FEFF}/u, ''));

/** Every `res/values/*.xml` whose root is `<resources>` is a rule; the default locale is `values/`, the rest `values-xx`. */
export async function detectAndroid(cwd: string): Promise<Detection> {
  const paths: string[] = (await fg('**/res/values/*.xml', { cwd, onlyFiles: true, dot: false, ignore: IGNORE })).sort();
  const rules: FileRule[] = [];
  const resDirs: Set<string> = new Set();

  for (const path of paths) {
    const name: string = posix.basename(path, '.xml');
    if (name === 'donottranslate' || !(await isResources(cwd, path))) continue;
    const namespace: string = kebab(name);
    const res: string = posix.dirname(posix.dirname(path));
    if (namespace === '') continue;
    resDirs.add(res);
    rules.push({ pattern: `${res}/values-{locale}/${name}.xml`, format: 'android', namespace });
  }

  if (rules.length === 0) return NONE;
  const notes: string[] = [];
  if (resDirs.size > 1) {
    notes.push(`Several Android modules hold a values/ directory (${[...resDirs].join(', ')}): each file gets its own rule, and a name used in two modules needs its own namespace in translify.json.`);
  }
  return { rules, notes };
}
