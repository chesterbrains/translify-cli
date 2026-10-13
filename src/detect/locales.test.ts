import { describe, expect, it } from 'vitest';

import { suggestLocaleMap } from './locales.js';

describe('suggestLocaleMap', () => {
  it('maps locales that differ only by case or separator', () => {
    expect(suggestLocaleMap(['en_US', 'it-IT', 'fr'], ['en-US', 'it-IT', 'fr'])).toEqual({ en_US: 'en-US' });
    expect(suggestLocaleMap(['pt_br'], ['pt-BR'])).toEqual({ pt_br: 'pt-BR' });
  });

  it('skips unrelated locales, and targets that would collide or chain', () => {
    expect(suggestLocaleMap(['de'], ['en-US'])).toEqual({});
    expect(suggestLocaleMap(['en_US', 'en-us'], ['en-US'])).toEqual({ en_US: 'en-US' });
    expect(suggestLocaleMap(['en_US', 'en-US'], ['en-US'])).toEqual({});
  });
});
