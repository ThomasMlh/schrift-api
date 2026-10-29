import { createDictionary } from '../../src/services/gameDb/dictionary.js';
import { extraTrait, treeTrait } from '../../src/services/gameDb/traits.js';
import { labelOf } from '../../src/services/gameDb/traitFilters.js';

const dict = createDictionary([
  { dictkey: 'belong_attribute_bad_status_probability_618231', content_fr: "Gêneur d'aucune catégorie" },
  { dictkey: 'lb_belong_attribute_bad_status_probability_618231_with_value', content_fr: "Gêneur d'aucune catégorie (+{value}[nbsp]%)" },
  { dictkey: 'belong_attribute_damage_up_618057', content_fr: 'Attaques puissantes renforcées Shinigamis' },
  { dictkey: 'lb_belong_attribute_damage_up_618057_with_value', content_fr: 'Attaques puissantes renforcées Shinigamis (+{value}[nbsp]%)' },
  { dictkey: 'lb_attribute_bad_status_probability_615331_with_value', content_fr: 'Gêneur de personnage connaissance' },
  { dictkey: 'lb_attribute_damage_up', content_fr: 'Augmentation des dégâts affinité' },
  { dictkey: 'lb_buff_time_up', content_fr: 'Soutien' },
  { dictkey: 'lb_buff_time_up_with_value', content_fr: 'Soutien' },
]);

const belongAttributes = new Map([
  ['618231', { id: '618231', parameter: '20', description: 'belong_attribute_bad_status_probability_618231' }],
  ['618057', { id: '618057', parameter: '20', description: 'belong_attribute_damage_up_618057' }],
  ['615331', { id: '615331', parameter: '10', description: 'attribute_bad_status_probability_615331' }],
]);

describe('soul tree abilities', () => {
  it('reads the value and the text of an ability limited to some enemies or allies', () => {
    expect(treeTrait(dict, 'belong_attribute_bad_status_probability', '618231', new Map(), belongAttributes))
      .toEqual({ kind: 'tree', type: 'belong_attribute_bad_status_probability', value: 20, ref: '618231', text: { fr: "Gêneur d'aucune catégorie (+20\u00a0%)" } });
    // The generic type text is replaced by the text of the referenced row
    expect(treeTrait(dict, 'attribute_damage_up', '618057', new Map(), belongAttributes).text).toEqual({ fr: 'Attaques puissantes renforcées Shinigamis (+20\u00a0%)' });
    // A "_with_value" text without placeholder gets the value appended
    expect(treeTrait(dict, 'attribute_bad_status_probability', '615331', new Map(), belongAttributes).text).toEqual({ fr: 'Gêneur de personnage connaissance (+10 %)' });
  });

  it('reads a duration of 10000 ms as 10 s, not as a reference', () => {
    expect(treeTrait(dict, 'buff_time_up', '10000')).toEqual({ kind: 'tree', type: 'buff_time_up', value: 10000, ref: null, text: { fr: 'Soutien (+10 s)' } });
  });

  it('gives every level of an EX ability limited to some enemies', () => {
    const row = { type: 'ex_belong_attribute_damage_up', level1_parameter: '618057', level2_parameter: '618057', level3_parameter: '', level4_parameter: '', level5_parameter: '' };
    expect(extraTrait(dict, row, new Map(), belongAttributes)).toMatchObject({ values: [20, 20], text: { fr: 'Attaques puissantes renforcées Shinigamis (+20\u00a0%)' } });
  });
});

describe('filter labels', () => {
  const filterDict = createDictionary([
    { dictkey: 'ui_sort_filter_passive_bad_state_brn_over_time', content_fr: 'Embrasement' },
    { dictkey: 'lb_effect_guild_battle_killer_effect_rate', content_fr: 'Effet tueur augmenté\nQuêtes de groupe' },
    { dictkey: 'ui_sort_filter_belong_enemy_bad_status_damage_rate', content_fr: 'Fléau catégorie/affinité' },
  ]);

  it('finds the game name of every kind of ability type, on one line', () => {
    expect(labelOf(filterDict, 'bad_state_brn_over_time')).toEqual({ fr: 'Embrasement' });
    expect(labelOf(filterDict, 'guild_battle_killer_effect_rate')).toEqual({ fr: 'Effet tueur augmenté (Quêtes de groupe)' });
    expect(labelOf(filterDict, 'attribute_enemy_bad_status_damage_rate')).toEqual({ fr: 'Fléau catégorie/affinité' });
    expect(labelOf(filterDict, 'unknown_type')).toEqual({ fr: 'unknown_type' });
  });
});
