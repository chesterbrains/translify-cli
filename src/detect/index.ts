import { detectFlutter } from './flutter.js';
import { detectI18next } from './i18next.js';
import type { Detection, Detector } from './shared.js';

export type { Detection, Detector } from './shared.js';

const DETECTORS: Detector[] = [detectI18next, detectFlutter];

/** Looks only in `cwd`. An empty `rules` list means "unknown, write an example". */
export async function detectLayout(cwd: string): Promise<Detection> {
  const rules: Detection['rules'] = [];
  const notes: string[] = [];
  for (const detect of DETECTORS) {
    const found: Detection = await detect(cwd);
    rules.push(...found.rules);
    notes.push(...found.notes);
  }

  return { rules, notes };
}
