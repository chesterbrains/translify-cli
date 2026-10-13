import fg from 'fast-glob';

import type { FileRule } from '../config.js';
import type { Detection } from './shared.js';

const I18NEXT_ROOTS: string[] = ['locales', 'public/locales', 'src/locales', 'src/i18n'];

export async function detectI18next(cwd: string): Promise<Detection> {
  const rules: FileRule[] = [];

  for (const root of I18NEXT_ROOTS) {
    const found: string[] = await fg(`${root}/*/*.json`, { cwd, onlyFiles: true });
    if (found.length > 0) rules.push({ pattern: `${root}/{locale}/{namespace}.json`, format: 'json', jsonStyle: 'nested' });
  }

  return { rules, notes: [] };
}
