/**
 * Details of a summon read from the game tables: draw modes, steps of a step-up summon, featured units
 * with their badge, and the medal shop opened with it. Rates and the full list of units that can be
 * drawn are not in the tables (gacha_rate_id and the draw groups point to server data).
 */
import { rmfsUrl } from './source.js';

// Read as optional: a dump without them only leaves the details empty
export const SUMMON_TABLES = ['m_step_up_gacha_group', 'm_step_up_gacha_layout', 'm_exchange_shop_category', 'm_exchange_shop_product', 'm_item'];

// The medal shop of a summon is the shop category numbered 100000 + summon group
const MEDAL_SHOP_OFFSET = 100000;

const toNumber = (value) => (value === '' || value === undefined || value === null ? null : Number(value));
const flag = (value) => value === '1';
const badgeUrl = (path) => (path ? rmfsUrl(`${path}.png`) : null);
const drawCount = (row) => [1, 2, 3].reduce((sum, i) => sum + (Number(row[`gacha_draw_count_${i}`]) || 0), 0);
const groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) map.set(row[key], [...(map.get(row[key]) ?? []), row]);
  return map;
};
const byNumber = (key) => (a, b) => Number(a[key]) - Number(b[key]);

// "2026-10-24 16:00:00" (server time) -> "24/10/2026 16:00"
const gameDateTime = (raw) => {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(raw || '');
  return match && match[1] !== '0000' ? `${match[3]}/${match[2]}/${match[1]} ${match[4]}:${match[5]}` : null;
};

// "2026-10-24 16:00:00" -> "24/10/2026"
const gameDay = (raw) => gameDateTime(raw)?.slice(0, 10) ?? null;

const gameInstant = (raw) => {
  const date = /^[1-9]\d{3}-/.test(raw || '') ? new Date(`${raw.replace(' ', 'T')}Z`) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

const CATEGORIES = {
  character: { gacha: 'character_gacha', ticket: 'character_ticket' },
  accessory: { gacha: 'accessory_gacha', ticket: 'accessory_ticket' },
};

export const TICKET_CATEGORIES = [CATEGORIES.character.ticket, CATEGORIES.accessory.ticket];

const summonType = (gachaType) => {
  if (/STEP_UP/.test(gachaType)) return 'step_up';
  if (/PICK|SELECTABLE|CHOICE/.test(gachaType)) return 'choice';
  return 'standard';
};

// What never expires ends years ahead in the tables (2034, 2099, 2126)
const PERMANENT_FROM_YEAR = 2030;
const isPermanent = (raw) => Number(raw?.slice(0, 4)) >= PERMANENT_FROM_YEAR;

// Every summon of the catalog, whether or not it features a site character. Summons of other contents
// (lucky boxes...) are left out.
export const createSummonCatalog = (tables, dict) => {
  const gachas = new Map((tables.m_gacha ?? []).map((r) => [r.id, r]));
  const items = new Map((tables.m_item ?? []).map((r) => [r.id, r]));
  return (tables.m_gacha_group ?? []).flatMap((group) => {
    const main = gachas.get(group.multiple_gacha_id) ?? gachas.get(group.single_gacha_id);
    const categories = CATEGORIES[main?.gacha_content_type];
    if (!categories) return [];
    const isTicket = main.payment_method === 'gacha_ticket';
    const endDate = isPermanent(main.end_date) ? null : main.end_date;
    return [{
      gacha_group_id: Number(group.id),
      name: dict.text(group.name) ?? dict.text(main.name),
      list_category: isTicket ? categories.ticket : categories.gacha,
      summon_type: summonType(main.gacha_type),
      start_date: gameDay(main.start_date),
      end_date: gameDay(endDate),
      started_at: gameInstant(main.start_date),
      ended_at: gameInstant(endDate),
      image_path: group.list_view_img_path ? `Localize/${group.list_view_img_path}` : null,
      ticket_icon_path: isTicket && items.get(main.gacha_ticket_id)?.resource_2d_id
        ? `Items/${items.get(main.gacha_ticket_id).resource_2d_id}/thumb.png`
        : null,
    }];
  });
};

export const createSummonDetails = (tables, dict) => {
  const gachas = new Map((tables.m_gacha ?? []).map((r) => [r.id, r]));
  const groups = new Map((tables.m_gacha_group ?? []).map((r) => [r.id, r]));
  const layoutsByGroup = groupBy(tables.m_gacha_layout ?? [], 'm_gacha_group_id');
  const stepsByGacha = groupBy(tables.m_step_up_gacha_group ?? [], 'm_gacha_id');
  const stepLayoutsByGroup = groupBy(tables.m_step_up_gacha_layout ?? [], 'm_gacha_group_id');
  const shopCategories = new Map((tables.m_exchange_shop_category ?? []).map((r) => [r.id, r]));
  const productsByCategory = groupBy(tables.m_exchange_shop_product ?? [], 'exchange_shop_category_id');

  const mode = (kind, gacha) => ({
    kind,
    type: gacha.gacha_type || null,
    payment: gacha.payment_method || null,
    price: toNumber(gacha.price),
    draws: drawCount(gacha),
    ticket_id: toNumber(gacha.gacha_ticket_id),
  });

  // Steps of a step-up summon, with the bonus badge the game shows on each one
  const stepsOf = (gacha, groupId) => {
    const badges = new Map();
    for (const layout of (stepLayoutsByGroup.get(groupId) ?? []).sort(byNumber('layout_order'))) {
      if (layout.badge_img_path && !badges.has(layout.number)) badges.set(layout.number, badgeUrl(layout.badge_img_path));
    }
    const rows = (stepsByGacha.get(gacha.id) ?? []).sort(byNumber('number'));
    return rows.map((row) => ({
      number: Number(row.number),
      price: toNumber(row.price),
      draws: drawCount(row),
      rarity_5: dict.text(row.rarity_5_rate_description),
      appeal: dict.text(row.appeal_statement),
      is_loop: flag(row.is_loop),
      badge: badges.get(row.number) ?? null,
    }));
  };

  const accessories = new Map((tables.m_accessory ?? []).map((r) => [r.id, r]));

  const featuredOf = (groupId) => {
    const featured = new Map();
    for (const layout of (layoutsByGroup.get(groupId) ?? []).sort(byNumber('layout_order'))) {
      const gameId = toNumber(layout.content_id);
      if (!gameId) continue;
      const current = featured.get(gameId);
      if (!current) featured.set(gameId, { game_id: gameId, badge: badgeUrl(layout.badge_img_path) });
      else if (!current.badge && layout.badge_img_path) current.badge = badgeUrl(layout.badge_img_path);
    }
    return [...featured.values()];
  };

  const medalShopOf = (groupId) => {
    const category = shopCategories.get(String(MEDAL_SHOP_OFFSET + Number(groupId)));
    if (!category) return null;
    return {
      name: dict.text(category.name),
      start_date: gameDateTime(category.start_date),
      end_date: gameDateTime(category.end_date),
      products: (productsByCategory.get(category.id) ?? []).sort(byNumber('id')).map((product) => ({
        name: dict.text(product.name),
        price: toNumber(product.price_1),
        limit: toNumber(product.limit_count) || null,
        type: product.content_type || null,
        content_id: toNumber(product.content_id),
        amount: toNumber(product.content_amount),
      })),
    };
  };

  // Details of a summon group, null when the tables do not have it
  return (groupId) => {
    const group = groups.get(String(groupId));
    if (!group) return null;
    const single = gachas.get(group.single_gacha_id);
    const multiple = gachas.get(group.multiple_gacha_id);
    const main = multiple ?? single;
    const steps = multiple ? stepsOf(multiple, String(groupId)) : [];
    const attentionKey = (stepsByGacha.get(multiple?.id) ?? []).find((r) => r.attention)?.attention;
    const featured = featuredOf(String(groupId));
    return {
      main_gacha_id: toNumber(main?.id),
      news_id: toNumber(group.news_id) || toNumber(main?.news_id) || null,
      category: main?.layout_category || null,
      start_at: gameDateTime(main?.start_date),
      end_at: gameDateTime(main?.end_date),
      modes: [single && mode('single', single), multiple && mode('multiple', multiple)].filter(Boolean),
      steps,
      attention: dict.text(attentionKey),
      featured,
      // Layouts of an accessory summon point to accessories, keyed by identity on the site
      accessory_identity_ids: main?.gacha_content_type === 'accessory'
        ? [...new Set(featured.map((f) => toNumber(accessories.get(String(f.game_id))?.identity_id)).filter(Boolean))]
        : [],
      medal_shop: medalShopOf(groupId),
    };
  };
};
