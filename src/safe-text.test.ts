import { describe, expect, it } from 'vitest';

import { safeText } from './safe-text.js';

describe('safeText', () => {
  it('leaves ordinary text alone, accents, emoji and quotes included', () => {
    for (const text of ['cart.title', 'Offre limitée — 50 %', 'こんにちは 👋', '"quoted" \\n is two characters', '']) expect(safeText(text)).toBe(text);
  });

  it('shows every control character as an escape instead of sending it', () => {
    expect(safeText('a\x1b[31mred\x1b[0m')).toBe('a\\x1b[31mred\\x1b[0m');
    expect(safeText('line1\nline2\r\ttab')).toBe('line1\\nline2\\r\\ttab');
    expect(safeText('bell\x07 nul\x00 del\x7f c1\x9b')).toBe('bell\\x07 nul\\x00 del\\x7f c1\\x9b');
    expect(safeText('ls\u2028ps\u2029')).toBe('ls\\u2028ps\\u2029');
  });

  it('leaves nothing a terminal would act on', () => {
    const every: string = Array.from({ length: 0xa0 }, (_, point) => String.fromCodePoint(point)).join('') + '\u2028\u2029';
    // eslint-disable-next-line no-control-regex -- the point of the test
    expect(safeText(every)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
  });
});
