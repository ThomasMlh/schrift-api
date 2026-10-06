import { loadComparableScores, cycleTimestamp, parseDate } from './killerRecords.js';
import { getMinScoresForRanking } from './podiumService/helpers.js';
import { CLEAR_SCORE_THRESHOLD } from '../utils/scoreThresholds.js';

/**
 * Succès des comptes bbs, calculés à partir des scores (rien n'est stocké) : un succès obtenu
 * disparaît si une correction de score fait qu'il n'est plus mérité. La date d'obtention d'un
 * palier est celle de la rotation (ou de la fin du cycle) qui l'a débloqué.
 *
 * Les valeurs (records, moyennes, podiums) n'utilisent que les scores comparables ; la
 * participation (rotations jouées, cycles complets, séries sans miss) compte tous les scores.
 */

export const PERFECT_SCORE = 621_000_000;
export const PERFECT_SCORE_PLUS = 621_400_000;
export const PERFECT_WEEK_SCORE = 620_000_000;
export const EXCEPTIONAL_CYCLE_TOTAL = 12_000_000_000;
// Le maximum réel d'une rotation tourne autour de 621,6M : au-delà, c'est une erreur de saisie,
// qui ne doit débloquer aucun succès (elle remonte dans « Scores à vérifier »).
export const MAX_PLAUSIBLE_SCORE = 625_000_000;
// Scores minimum sur chacun des deux cycles pour qu'une progression de moyenne compte
export const MIN_PROGRESSION_SCORES = 10;

export const TIER_ORDER = ['bronze', 'silver', 'gold', 'platinum'];

// Libellés français, pour les messages Discord et le bot (le site a ses propres traductions)
export const TIER_LABELS_FR = { bronze: 'Bronze', silver: 'Argent', gold: 'Or', platinum: 'Platine' };
export const ACHIEVEMENT_NAMES_FR = {
  first_step: 'Premier pas', clear: 'Clear', perfect_score: 'Score parfait', perfect_week: 'Semaine parfaite',
  exceptional_cycle: "Cycle d'exception", immaculate_cycle: 'Cycle immaculé', billionaire: 'Milliardaire',
  outdone: 'Dépassement', reference: 'Référence', living_legend: 'Légende vivante', veteran: 'Vétéran',
  diligent: 'Assidu', full_cycle: 'Cycle complet', flawless: 'Sans faute', unstoppable: 'Inarrêtable',
  loyal: 'Fidèle', comeback: 'Le retour', improving: 'En progrès', revelation: 'Révélation',
  on_a_roll: 'Sur sa lancée', podium: 'Sur le podium', leader: 'Meneur', elite: 'Élite',
  number_one: 'Numéro un', week_king: 'Roi de la semaine', versatile: 'Touche-à-tout',
};

const t = (bronze, silver, gold, platinum) => [
  ['bronze', bronze], ['silver', silver], ['gold', gold], ['platinum', platinum],
].filter(([, threshold]) => threshold !== undefined).map(([tier, threshold]) => ({ tier, threshold }));

// unit : comment le front affiche la valeur et les seuils (count, score, billions, percent, flag)
export const ACHIEVEMENTS = [
  { code: 'first_step', category: 'scores', unit: 'flag', tiers: t(1) },
  { code: 'clear', category: 'scores', unit: 'count', tiers: t(3, 15, 40, 100) },
  { code: 'perfect_score', category: 'scores', unit: 'score', tiers: t(undefined, undefined, PERFECT_SCORE, PERFECT_SCORE_PLUS) },
  { code: 'perfect_week', category: 'scores', unit: 'count', tiers: t(1, 5, 15) },
  { code: 'exceptional_cycle', category: 'scores', unit: 'flag', tiers: t(undefined, undefined, 1) },
  { code: 'immaculate_cycle', category: 'scores', unit: 'flag', tiers: t(undefined, undefined, undefined, 1) },
  { code: 'billionaire', category: 'scores', unit: 'billions', tiers: t(10e9, 50e9, 150e9) },
  { code: 'outdone', category: 'records', unit: 'count', tiers: t(5, 25, 60) },
  { code: 'reference', category: 'records', unit: 'flag', tiers: t(undefined, 1) },
  { code: 'living_legend', category: 'records', unit: 'count', tiers: t(undefined, undefined, undefined, 5) },
  { code: 'veteran', category: 'regularity', unit: 'count', tiers: t(3, 5, 10) },
  { code: 'diligent', category: 'regularity', unit: 'count', tiers: t(20, 100, 260) },
  { code: 'full_cycle', category: 'regularity', unit: 'count', tiers: t(1, 5, 10) },
  { code: 'flawless', category: 'regularity', unit: 'count', tiers: t(undefined, undefined, 40) },
  { code: 'unstoppable', category: 'regularity', unit: 'count', tiers: t(undefined, undefined, undefined, 5) },
  { code: 'loyal', category: 'regularity', unit: 'count', tiers: t(undefined, 5) },
  { code: 'comeback', category: 'regularity', unit: 'flag', tiers: t(1) },
  { code: 'improving', category: 'progression', unit: 'percent', tiers: t(10, 25, 50) },
  { code: 'revelation', category: 'progression', unit: 'flag', tiers: t(undefined, 1) },
  { code: 'on_a_roll', category: 'progression', unit: 'count', tiers: t(undefined, undefined, 3) },
  { code: 'podium', category: 'podium', unit: 'count', tiers: t(1, 3, 8) },
  { code: 'leader', category: 'podium', unit: 'count', tiers: t(1, 3, 6) },
  { code: 'elite', category: 'podium', unit: 'count', tiers: t(1, 3, 5) },
  { code: 'number_one', category: 'podium', unit: 'flag', tiers: t(undefined, undefined, undefined, 1) },
  { code: 'week_king', category: 'podium', unit: 'count', tiers: t(1, 5, 15) },
  { code: 'versatile', category: 'versatility', unit: 'count', tiers: t(3, 8, 15, 20) },
];

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;

// --- Timelines : valeur d'un succès dans le temps, pour dater chaque palier --------------------

// Une entrée par occurrence (dates triées) : la valeur est le nombre d'occurrences
const countTimeline = (dates) => [...dates].sort((a, b) => a - b).map((at, i) => ({ value: i + 1, at }));

// Nouvelles valeurs maximales atteintes, dans l'ordre chronologique
const maxTimeline = (points) => {
  const timeline = [];
  let best = -Infinity;
  for (const p of [...points].sort((a, b) => a.at - b.at)) {
    if (p.value > best) {
      best = p.value;
      timeline.push({ value: p.value, at: p.at });
    }
  }
  return timeline;
};

// Plus longue série d'indices consécutifs (cycles) satisfaisant une condition
const streakTimeline = (items) => {
  const points = [];
  let run = 0;
  let previous = null;
  for (const item of [...items].sort((a, b) => a.index - b.index)) {
    run = previous !== null && item.index === previous + 1 ? run + 1 : 1;
    previous = item.index;
    points.push({ value: run, at: item.at });
  }
  return maxTimeline(points);
};

const lastValue = (timeline) => (timeline.length ? timeline[timeline.length - 1].value : 0);

// --- Contexte global (tous les comptes), mis en cache -----------------------------------------

const buildContext = async (db, now) => {
  const cycles = (await db.collection('cycles').find({}, { projection: { name: 1, year: 1, rotations: 1, created_at: 1 } }).toArray())
    .filter((c) => c.rotations?.length && cycleTimestamp(c) <= now)
    .sort((a, b) => cycleTimestamp(a) - cycleTimestamp(b));

  const cycleIndex = new Map(cycles.map((c, i) => [c._id.toString(), i]));
  const slot = new Map(); // `${cycle_id}|${rotation_id}` -> { ri, at }
  const cycleInfo = cycles.map((c) => {
    const rotationDates = c.rotations.map((r) => parseDate(r.end_date) || parseDate(r.start_date) || cycleTimestamp(c));
    c.rotations.forEach((r, ri) => slot.set(`${c._id}|${r.rotation_id}`, { ri, at: rotationDates[ri] }));
    const end = rotationDates[rotationDates.length - 1];
    return { size: c.rotations.length, rotationDates, end, ended: end + DAY_MS <= now };
  });

  const [allScores, comparable, minScores] = await Promise.all([
    db.collection('scores').find(
      { bbs_id: { $ne: null } },
      { projection: { bbs_id: 1, bbs_name: 1, cycle_id: 1, rotation_id: 1, guild_id: 1, score: 1 } }
    ).toArray(),
    loadComparableScores(db, {}),
    getMinScoresForRanking(db),
  ]);
  const comparableIds = new Set(comparable.map((s) => s._id.toString()));

  const scores = [];
  for (const s of allScores) {
    const ci = cycleIndex.get(s.cycle_id);
    const position = slot.get(`${s.cycle_id}|${s.rotation_id}`);
    if (ci === undefined || !position) continue;
    scores.push({
      bbs: s.bbs_id, name: s.bbs_name, guild: s.guild_id, rotation: s.rotation_id,
      ci, ri: position.ri, at: position.at, v: s.score || 0,
      comparable: comparableIds.has(s._id.toString()) && (s.score || 0) <= MAX_PLAUSIBLE_SCORE,
    });
  }
  scores.sort((a, b) => a.ci - b.ci || a.ri - b.ri);

  const byAccount = new Map();
  for (const s of scores) {
    if (!byAccount.has(s.bbs)) byAccount.set(s.bbs, []);
    byAccount.get(s.bbs).push(s);
  }

  // Statistiques par compte et par cycle
  const cycleStats = new Map(); // `${bbs}|${ci}` -> stats
  for (const [bbs, list] of byAccount) {
    const byCycle = new Map();
    for (const s of list) {
      if (!byCycle.has(s.ci)) byCycle.set(s.ci, []);
      byCycle.get(s.ci).push(s);
    }
    for (const [ci, cycleScores] of byCycle) {
      const values = cycleScores.filter((s) => s.comparable);
      const guildCounts = new Map();
      for (const s of cycleScores) guildCounts.set(s.guild, (guildCounts.get(s.guild) || 0) + 1);
      const total = values.reduce((sum, s) => sum + s.v, 0);
      cycleStats.set(`${bbs}|${ci}`, {
        bbs, ci, scores: cycleScores,
        n: values.length,
        total,
        avg: values.length ? total / values.length : 0,
        guild: [...guildCounts].sort((a, b) => b[1] - a[1])[0][0],
        played: cycleScores.length,
        lastAt: Math.max(...cycleScores.map((s) => s.at)),
      });
    }
  }

  // Record absolu de chaque killer (le premier à l'atteindre en cas d'égalité)
  const absoluteRecord = new Map();
  for (const s of scores) {
    if (!s.comparable) continue;
    const best = absoluteRecord.get(s.rotation);
    if (!best || s.v > best.v) absoluteRecord.set(s.rotation, s);
  }

  // Podiums des cycles terminés (moyenne, même seuil minimum que le podium du site)
  const required = Math.max(1, minScores);
  const podiumDates = { podium: new Map(), leader: new Map(), elite: new Map(), number_one: new Map() };
  const push = (map, bbs, at) => { if (!map.has(bbs)) map.set(bbs, []); map.get(bbs).push(at); };
  for (let ci = 0; ci < cycles.length; ci++) {
    if (!cycleInfo[ci].ended) continue;
    const at = cycleInfo[ci].end;
    const rows = [...cycleStats.values()].filter((st) => st.ci === ci && st.n >= required).sort((a, b) => b.avg - a.avg);
    rows.slice(0, 10).forEach((st) => push(podiumDates.elite, st.bbs, at));
    if (rows[0]) push(podiumDates.number_one, rows[0].bbs, at);
    const byGuild = new Map();
    for (const st of rows) {
      if (!byGuild.has(st.guild)) byGuild.set(st.guild, []);
      byGuild.get(st.guild).push(st);
    }
    for (const guildRows of byGuild.values()) {
      guildRows.slice(0, 3).forEach((st) => push(podiumDates.podium, st.bbs, at));
      push(podiumDates.leader, guildRows[0].bbs, at);
    }
  }

  // Progressions de moyenne entre deux cycles terminés consécutifs
  const progressions = new Map(); // bbs -> [{ index, pct, at, guild }]
  for (const st of cycleStats.values()) {
    if (st.ci === 0 || !cycleInfo[st.ci].ended || st.n < MIN_PROGRESSION_SCORES) continue;
    const previous = cycleStats.get(`${st.bbs}|${st.ci - 1}`);
    if (!previous || previous.n < MIN_PROGRESSION_SCORES || previous.avg <= 0) continue;
    if (!progressions.has(st.bbs)) progressions.set(st.bbs, []);
    progressions.get(st.bbs).push({
      index: st.ci, pct: Math.round(((st.avg - previous.avg) / previous.avg) * 1000) / 10, at: cycleInfo[st.ci].end, guild: st.guild,
    });
  }
  const revelationDates = new Map();
  const bestByGuildCycle = new Map();
  for (const [bbs, list] of progressions) {
    for (const p of list) {
      const key = `${p.guild}|${p.index}`;
      const current = bestByGuildCycle.get(key);
      if (!current || p.pct > current.pct) bestByGuildCycle.set(key, { bbs, pct: p.pct, at: p.at });
    }
  }
  for (const best of bestByGuildCycle.values()) if (best.pct > 0) push(revelationDates, best.bbs, best.at);

  // Roi de la semaine : meilleur total des 2 rotations d'une semaine terminée, par guilde
  const weekTotals = new Map(); // `${ci}|${week}|${guild}` -> Map(bbs -> total)
  for (const s of scores) {
    if (!s.comparable) continue;
    const week = Math.floor(s.ri / 2);
    const weekEnd = cycleInfo[s.ci].rotationDates[Math.min(week * 2 + 1, cycleInfo[s.ci].size - 1)];
    if (weekEnd + DAY_MS > now) continue;
    const key = `${s.ci}|${week}|${s.guild}`;
    if (!weekTotals.has(key)) weekTotals.set(key, { at: weekEnd, totals: new Map() });
    const entry = weekTotals.get(key);
    entry.totals.set(s.bbs, (entry.totals.get(s.bbs) || 0) + s.v);
  }
  const weekKingDates = new Map();
  for (const { at, totals } of weekTotals.values()) {
    const best = Math.max(...totals.values());
    if (best <= 0) continue;
    for (const [bbs, total] of totals) if (total === best) push(weekKingDates, bbs, at);
  }

  const context = {
    now, cycles, cycleInfo, byAccount, cycleStats, absoluteRecord, podiumDates, progressions, revelationDates, weekKingDates,
  };
  context.results = new Map([...byAccount.keys()].map((bbs) => [bbs, evaluateAccount(context, bbs)]));
  context.rarity = computeRarity(context.results);
  return context;
};

// --- Évaluation d'un compte -----------------------------------------------------------------

const evaluateAccount = (ctx, bbs) => {
  const list = ctx.byAccount.get(bbs) || [];
  const values = list.filter((s) => s.comparable);
  const stats = [...ctx.cycleStats.values()].filter((st) => st.bbs === bbs).sort((a, b) => a.ci - b.ci);
  const isComplete = (st) => st.played === ctx.cycleInfo[st.ci].size && st.scores.every((s) => s.v > 0);
  const timelines = {};

  timelines.first_step = list.length ? [{ value: 1, at: list[0].at }] : [];
  timelines.clear = countTimeline(values.filter((s) => s.v >= CLEAR_SCORE_THRESHOLD).map((s) => s.at));
  timelines.perfect_score = maxTimeline(values.map((s) => ({ value: s.v, at: s.at })));

  const weeks = new Map();
  for (const s of values) {
    const key = `${s.ci}|${Math.floor(s.ri / 2)}`;
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(s);
  }
  timelines.perfect_week = countTimeline([...weeks.values()]
    .filter((w) => w.length === 2 && w.every((s) => s.v >= PERFECT_WEEK_SCORE))
    .map((w) => Math.max(...w.map((s) => s.at))));

  timelines.exceptional_cycle = maxTimeline(stats.filter((st) => st.total >= EXCEPTIONAL_CYCLE_TOTAL).map((st) => ({ value: 1, at: st.lastAt })));
  timelines.immaculate_cycle = maxTimeline(stats
    .filter((st) => st.n === ctx.cycleInfo[st.ci].size && st.scores.every((s) => s.comparable && s.v >= PERFECT_SCORE))
    .map((st) => ({ value: 1, at: st.lastAt })));

  let cumulative = 0;
  timelines.billionaire = values.map((s) => ({ value: (cumulative += s.v), at: s.at }));

  // Records personnels : meilleur score sur un killer battu (cycles antérieurs uniquement)
  const recordDates = [];
  const bestByRotation = new Map();
  for (const st of stats) {
    const cycleValues = st.scores.filter((s) => s.comparable);
    for (const s of cycleValues) {
      const best = bestByRotation.get(s.rotation);
      if (best !== undefined && s.v > best) recordDates.push(s.at);
    }
    for (const s of cycleValues) bestByRotation.set(s.rotation, Math.max(bestByRotation.get(s.rotation) ?? -Infinity, s.v));
  }
  timelines.outdone = countTimeline(recordDates);

  const held = [...ctx.absoluteRecord.values()].filter((s) => s.bbs === bbs).map((s) => s.at).sort((a, b) => a - b);
  timelines.reference = held.length ? [{ value: 1, at: held[0] }] : [];
  timelines.living_legend = held.length ? [{ value: held.length, at: held[held.length - 1] }] : [];

  timelines.veteran = countTimeline(stats.map((st) => Math.min(...st.scores.map((s) => s.at))));
  timelines.diligent = countTimeline(list.map((s) => s.at));
  const complete = stats.filter(isComplete);
  timelines.full_cycle = countTimeline(complete.map((st) => st.lastAt));

  // Plus longue série de rotations sans miss (une rotation non saisie casse la série)
  const played = new Map(list.map((s) => [`${s.ci}|${s.ri}`, s.v]));
  const streakPoints = [];
  if (list.length) {
    let run = 0;
    for (let ci = list[0].ci; ci < ctx.cycles.length; ci++) {
      const info = ctx.cycleInfo[ci];
      for (let ri = ci === list[0].ci ? list[0].ri : 0; ri < info.size; ri++) {
        const v = played.get(`${ci}|${ri}`);
        // Les rotations pas encore terminées ne cassent pas la série (scores pas encore saisis)
        if (v === undefined && info.rotationDates[ri] + DAY_MS > ctx.now) continue;
        run = v > 0 ? run + 1 : 0;
        if (run > 0) streakPoints.push({ value: run, at: info.rotationDates[ri] });
      }
    }
  }
  timelines.flawless = maxTimeline(streakPoints);
  timelines.unstoppable = streakTimeline(complete.map((st) => ({ index: st.ci, at: st.lastAt })));

  const loyaltyPoints = [];
  stats.forEach((st, i) => {
    const previous = stats[i - 1];
    const run = previous && st.ci === previous.ci + 1 && st.guild === previous.guild ? loyaltyPoints[loyaltyPoints.length - 1].value + 1 : 1;
    loyaltyPoints.push({ value: run, at: st.lastAt });
  });
  timelines.loyal = maxTimeline(loyaltyPoints);

  const playedCycles = new Set(stats.map((st) => st.ci));
  const comeback = complete.find((st) => st.ci > 0 && !playedCycles.has(st.ci - 1) && stats.some((o) => o.ci < st.ci - 1));
  timelines.comeback = comeback ? [{ value: 1, at: comeback.lastAt }] : [];

  const progressions = ctx.progressions.get(bbs) || [];
  timelines.improving = maxTimeline(progressions.map((p) => ({ value: p.pct, at: p.at })));
  timelines.revelation = countTimeline(ctx.revelationDates.get(bbs) || []);
  timelines.on_a_roll = streakTimeline(progressions.filter((p) => p.pct > 0));

  timelines.podium = countTimeline(ctx.podiumDates.podium.get(bbs) || []);
  timelines.leader = countTimeline(ctx.podiumDates.leader.get(bbs) || []);
  timelines.elite = countTimeline(ctx.podiumDates.elite.get(bbs) || []);
  timelines.number_one = countTimeline(ctx.podiumDates.number_one.get(bbs) || []);
  timelines.week_king = countTimeline(ctx.weekKingDates.get(bbs) || []);

  const firstClearByKiller = new Map();
  for (const s of values) if (s.v >= CLEAR_SCORE_THRESHOLD && !firstClearByKiller.has(s.rotation)) firstClearByKiller.set(s.rotation, s.at);
  timelines.versatile = countTimeline([...firstClearByKiller.values()]);

  return ACHIEVEMENTS.map((def) => {
    const timeline = timelines[def.code];
    const value = lastValue(timeline);
    const tiers = def.tiers.map(({ tier, threshold }) => ({
      tier, threshold, unlocked_at: timeline.find((p) => p.value >= threshold)?.at ?? null,
    }));
    const unlocked = tiers.filter((tr) => tr.unlocked_at !== null);
    const next = tiers.find((tr) => tr.unlocked_at === null) || null;
    return {
      code: def.code,
      name: ACHIEVEMENT_NAMES_FR[def.code],
      category: def.category,
      unit: def.unit,
      value: Math.max(0, value),
      current_tier: unlocked.length ? unlocked[unlocked.length - 1].tier : null,
      next_tier: next ? { tier: next.tier, threshold: next.threshold } : null,
      tiers,
    };
  });
};

const computeRarity = (results) => {
  const total = results.size;
  const rarity = new Map(); // `${code}|${tier}` -> % de comptes
  for (const def of ACHIEVEMENTS) {
    for (const { tier } of def.tiers) {
      let count = 0;
      for (const list of results.values()) {
        if (list.find((a) => a.code === def.code)?.tiers.find((tr) => tr.tier === tier)?.unlocked_at !== null) count++;
      }
      rarity.set(`${def.code}|${tier}`, total ? Math.round((count / total) * 1000) / 10 : 0);
    }
  }
  return rarity;
};

let cache = null;

/** Vide le cache (appelé à chaque modification de score). */
export const invalidateAchievementsCache = () => { cache = null; };

const getContext = async (db, now) => {
  if (!cache || now - cache.builtAt > CACHE_TTL_MS) {
    cache = { builtAt: now, promise: buildContext(db, now) };
    cache.promise.catch(() => { cache = null; });
  }
  return cache.promise;
};

/**
 * Succès de chaque compte demandé, avec la rareté de chaque palier (% des comptes ayant au moins
 * un score qui l'ont débloqué).
 * @returns {Promise<{ accounts: Map<string, Array>, totalAccounts: number }>}
 */
export const getAchievementsForAccounts = async (db, bbsIds, { now = Date.now(), fresh = false } = {}) => {
  const ctx = fresh ? await buildContext(db, now) : await getContext(db, now);
  const empty = evaluateAccount(ctx, null);
  const accounts = new Map(bbsIds.map((bbs) => {
    const list = ctx.results.get(bbs) || empty;
    return [bbs, list.map((a) => ({
      ...a,
      tiers: a.tiers.map((tr) => ({ ...tr, rarity: ctx.rarity.get(`${a.code}|${tr.tier}`) ?? 0 })),
    }))];
  }));
  return { accounts, totalAccounts: ctx.results.size };
};

/**
 * Paliers débloqués (par défaut or et platine), pour tous les comptes ou ceux demandés, avec le
 * dernier pseudo connu du compte et la rareté du palier.
 */
export const listUnlockedTiers = async (db, { tiers = ['gold', 'platinum'], bbsIds = null, now = Date.now() } = {}) => {
  const ctx = await getContext(db, now);
  const wanted = bbsIds ? new Set(bbsIds) : null;
  const unlocked = [];
  for (const [bbs, list] of ctx.results) {
    if (wanted && !wanted.has(bbs)) continue;
    const scores = ctx.byAccount.get(bbs) || [];
    const name = scores.length ? scores[scores.length - 1].name : null;
    for (const a of list) {
      for (const tr of a.tiers) {
        if (tr.unlocked_at === null || !tiers.includes(tr.tier)) continue;
        unlocked.push({
          bbs_id: bbs, bbs_name: name, code: a.code, name: a.name, tier: tr.tier,
          unlocked_at: tr.unlocked_at, rarity: ctx.rarity.get(`${a.code}|${tr.tier}`) ?? 0,
        });
      }
    }
  }
  return unlocked;
};

/**
 * Succès le plus rare débloqué par chaque compte (rareté la plus basse, puis palier le plus élevé),
 * pour l'afficher à côté du pseudo dans les classements.
 * @returns {Promise<Map<string, { code, name, tier, rarity }>>}
 */
export const getTopAchievements = async (db, bbsIds, { now = Date.now() } = {}) => {
  const top = new Map();
  if (bbsIds.length === 0) return top;
  const ctx = await getContext(db, now);
  for (const bbs of bbsIds) {
    let best = null;
    for (const a of ctx.results.get(bbs) || []) {
      for (const tr of a.tiers) {
        if (tr.unlocked_at === null) continue;
        const rarity = ctx.rarity.get(`${a.code}|${tr.tier}`) ?? 0;
        const better = !best || rarity < best.rarity
          || (rarity === best.rarity && TIER_ORDER.indexOf(tr.tier) > TIER_ORDER.indexOf(best.tier));
        if (better) best = { code: a.code, name: a.name, tier: tr.tier, rarity };
      }
    }
    if (best) top.set(bbs, best);
  }
  return top;
};
