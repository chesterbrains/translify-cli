import type { FileRule } from '../config.js';

export interface Detection {
  rules: FileRule[];
  /** Printed after "Found:", one line each; advice, never an error. */
  notes: string[];
}

export type Detector = (cwd: string) => Promise<Detection>;

export const NONE: Detection = { rules: [], notes: [] };

/** `MyApp_Web` → `myapp-web`; an empty result is the caller's problem (it picks a fallback). */
export const kebab = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Patterns are written with `/`; a Windows-edited path still becomes one. */
export const posixPath = (value: string): string => value.replaceAll('\\', '/').replace(/^(\.\/)+/, '');
