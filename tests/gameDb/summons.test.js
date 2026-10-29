import { createDictionary } from '../../src/services/gameDb/dictionary.js';
import { createSummonDetails } from '../../src/services/gameDb/summons.js';

const dict = createDictionary([
  { dictkey: 'rate5', content_fr: '5 % de chance d\'obtenir un 5★' },
  { dictkey: 'pick', content_fr: '[ffff00]Un 5★ de la sélection garanti[nbsp]![-]' },
  { dictkey: 'discount', content_fr: '250→150 orbes spirituels !' },
  { dictkey: 'warn', content_fr: 'Chaque tirage x10 garantit un 5★' },
  { dictkey: 'shop', content_fr: 'Médailles Refine 2' },
  { dictkey: 'ichigo', content_fr: 'Ichigo' },
]);

const step = (number, fields) => ({
  m_gacha_id: '8672', number: String(number), is_loop: '0', rarity_5_rate_description: 'rate5', appeal_statement: '',
  attention: 'warn', price: '250', gacha_draw_count_1: '9', gacha_draw_count_2: '1', gacha_draw_count_3: '', ...fields,
});

const tables = {
  m_gacha_group: [{ id: '867', single_gacha_id: '8671', multiple_gacha_id: '8672', news_id: '9292' }],
  m_gacha: [
    { id: '8671', gacha_type: 'GACHA_BASIC', payment_method: 'gold', price: '25', gacha_draw_count_1: '1', layout_category: 'limited', start_date: '2026-10-24 16:00:00', end_date: '2026-11-07 15:59:59' },
    { id: '8672', gacha_type: 'GACHA_NO_RESET_STEP_UP', payment_method: 'gold', price: '0', layout_category: 'limited', start_date: '2026-10-24 16:00:00', end_date: '2026-11-07 15:59:59' },
  ],
  m_gacha_layout: [
    { m_gacha_group_id: '867', layout_order: '50', content_id: '', badge_img_path: '' },
    { m_gacha_group_id: '867', layout_order: '3', content_id: '65122', badge_img_path: 'Shop/Limited/gacha_badge_rare5_05' },
    { m_gacha_group_id: '867', layout_order: '4', content_id: '65122', badge_img_path: '' },
  ],
  m_step_up_gacha_group: [
    step(2, { rarity_5_rate_description: 'pick', is_loop: '1' }),
    step(1, { price: '150', appeal_statement: 'discount' }),
  ],
  m_step_up_gacha_layout: [{ m_gacha_group_id: '867', number: '2', layout_order: '4', badge_img_path: 'Shop/Limited/gacha_badge_rare5_pick_fixed' }],
  m_exchange_shop_category: [{ id: '100867', name: 'shop', start_date: '2026-10-24 16:00:00', end_date: '2026-11-07 15:59:59' }],
  m_exchange_shop_product: [
    { id: '10086702', exchange_shop_category_id: '100867', name: 'ichigo', price_1: '60', limit_count: '1', content_type: 'item', content_id: '350', content_amount: '1' },
    { id: '10086701', exchange_shop_category_id: '100867', name: 'ichigo', price_1: '200', limit_count: '0', content_type: 'character', content_id: '5122', content_amount: '1' },
  ],
};

describe('summon details', () => {
  const details = createSummonDetails(tables, dict);

  it('reads the modes, the steps in order with their texts and badges, and the featured units', () => {
    const summon = details(867);
    expect(summon).toMatchObject({
      news_id: 9292,
      category: 'limited',
      start_at: '24/10/2026 16:00',
      end_at: '07/11/2026 15:59',
      modes: [
        { kind: 'single', type: 'GACHA_BASIC', payment: 'gold', price: 25, draws: 1 },
        { kind: 'multiple', type: 'GACHA_NO_RESET_STEP_UP', price: 0 },
      ],
      attention: { fr: 'Chaque tirage x10 garantit un 5★' },
      featured: [{ game_id: 65122, badge: expect.stringMatching(/\/fr\/Shop\/Limited\/gacha_badge_rare5_05\.png$/) }],
    });
    expect(summon.steps).toEqual([
      { number: 1, price: 150, draws: 10, rarity_5: { fr: '5 % de chance d\'obtenir un 5★' }, appeal: { fr: '250→150 orbes spirituels !' }, is_loop: false, badge: null },
      { number: 2, price: 250, draws: 10, rarity_5: { fr: 'Un 5★ de la sélection garanti\u00a0!' }, appeal: null, is_loop: true, badge: expect.stringMatching(/gacha_badge_rare5_pick_fixed\.png$/) },
    ]);
  });

  it('reads the medal shop of the summon, products in game order and no limit as null', () => {
    expect(details(867).medal_shop).toEqual({
      name: { fr: 'Médailles Refine 2' },
      start_date: '24/10/2026 16:00',
      end_date: '07/11/2026 15:59',
      products: [
        { name: { fr: 'Ichigo' }, price: 200, limit: null, type: 'character', content_id: 5122, amount: 1 },
        { name: { fr: 'Ichigo' }, price: 60, limit: 1, type: 'item', content_id: 350, amount: 1 },
      ],
    });
  });

  it('gives null for a group the tables do not have', () => {
    expect(details(1)).toBeNull();
  });
});
