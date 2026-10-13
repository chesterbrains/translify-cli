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

  it('maps a bare language to the only regional project locale', () => {
    expect(suggestLocaleMap(['en', 'it'], ['en-US', 'it-IT'])).toEqual({ en: 'en-US', it: 'it-IT' });
    expect(suggestLocaleMap(['EN'], ['en-US'])).toEqual({ EN: 'en-US' });
  });

  it('leaves a bare language alone when the project has it, or has several regions', () => {
    expect(suggestLocaleMap(['en'], ['en', 'en-US'])).toEqual({});
    expect(suggestLocaleMap(['en'], ['en-US', 'en-GB'])).toEqual({});
    expect(suggestLocaleMap(['en'], ['fr-FR'])).toEqual({});
  });

  it('does not give a bare language a target another disk locale already took', () => {
    expect(suggestLocaleMap(['en_US', 'en'], ['en-US'])).toEqual({ en_US: 'en-US' });
    expect(suggestLocaleMap(['en', 'en-US'], ['en-US'])).toEqual({});
  });
});
