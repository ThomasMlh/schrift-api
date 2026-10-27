import { parseCsv } from '../../src/services/gameDb/csv.js';
import { cleanMarkup, createDictionary } from '../../src/services/gameDb/dictionary.js';

describe('parseCsv', () => {
  it('reads quoted fields with commas, quotes and line breaks', () => {
    const rows = parseCsv('﻿id,text,other\r\n1,"a, ""b""\nc",x\n2,,y\n');
    expect(rows).toEqual([
      { id: '1', text: 'a, "b"\nc', other: 'x' },
      { id: '2', text: '', other: 'y' },
    ]);
  });

  it('fills missing trailing cells with empty strings', () => {
    expect(parseCsv('a,b,c\n1,2')).toEqual([{ a: '1', b: '2', c: '' }]);
  });
});

describe('dictionary', () => {
  const dict = createDictionary([
    { dictkey: 'lb_x_with_value', content_fr: 'Dégâts +{value}[nbsp]%', content_en: '' },
    { dictkey: 'lb_name', content_fr: 'Kisuke', content_en: 'Kisuke EN' },
    { dictkey: 'lb_empty', content_fr: '', content_en: '' },
  ]);

  it('keeps every language that has a text and fills placeholders', () => {
    expect(dict.text('lb_x_with_value', { value: 20 })).toEqual({ fr: 'Dégâts +20 %' });
    expect(dict.text('lb_name')).toEqual({ fr: 'Kisuke', en: 'Kisuke EN' });
    expect(dict.text('lb_empty')).toBeNull();
    expect(dict.languages).toEqual(['fr', 'en']);
  });

  it('removes the game markup', () => {
    expect(cleanMarkup('99[sup]e[/sup] technique\nde [ff0000]feu[-]')).toBe('99e technique de feu');
  });
});
