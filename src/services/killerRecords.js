import { ObjectId } from 'mongodb';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * Records et historique par killer.
 *
 * Un document `rotations` est un modèle (killer + type d'attaque + altération) réutilisé d'un cycle
 * à l'autre : comparer des scores "sur le même killer" revient donc à comparer à rotation_id égal.
 * Le champ `score` (points gagnés sur la rotation elle-même) est comparable entre cycles même quand
 * un killer passe d'une rotation de base à une différentielle ; `raw_score` (cumul hebdo) ne l'est pas.
 */

const parseDate = (s) => {
  if (!s) return 0;
  const [day, month, year] = s.split('/');
  return new Date(year, month - 1, day).getTime() || 0;
};

const cycleTimestamp = (cycle) => parseDate(cycle.rotations?.[0]?.start_date) || new Date(cycle.created_at || 0).getTime();

const toObjectIds = (ids) => ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));

/**
 * Charge les scores correspondant au filtre en écartant ceux qui ne sont pas comparables : un score
 * différentiel sans score de base dans la même semaine du même cycle vaut le cumul hebdomadaire
 * entier (computeDifferential retombe sur raw_score faute de base), pas les points de la rotation,
 * et créerait de faux records.
 */
export const loadComparableScores = async (db, filter) => {
  const scores = await db.collection('scores').find({ ...filter, bbs_id: { $ne: null } }).toArray();
  const differentials = scores.filter((s) => s.is_differential);
  if (differentials.length === 0) return scores;

  const cycleIds = [...new Set(differentials.map((s) => s.cycle_id))];
  const cycles = await db.collection('cycles')
    .find({ _id: { $in: toObjectIds(cycleIds) } }, { projection: { rotations: 1 } })
    .toArray();

  // `${cycle_id}|${rotation_id}` -> rotation_id de la rotation précédente dans ce cycle
  const previousRotation = new Map();
  for (const cycle of cycles) {
    (cycle.rotations || []).forEach((r, i) => {
      if (i > 0) previousRotation.set(`${cycle._id}|${r.rotation_id}`, cycle.rotations[i - 1].rotation_id);
    });
  }

  const baseKeyOf = (s) => `${s.cycle_id}|${s.bbs_id}|${previousRotation.get(`${s.cycle_id}|${s.rotation_id}`)}`;
  const baseRotationIds = [...new Set(differentials.map((s) => previousRotation.get(`${s.cycle_id}|${s.rotation_id}`)).filter(Boolean))];

  const bases = await db.collection('scores').find(
    {
      cycle_id: { $in: cycleIds },
      rotation_id: { $in: baseRotationIds },
      bbs_id: { $in: [...new Set(differentials.map((s) => s.bbs_id))] },
    },
    { projection: { cycle_id: 1, bbs_id: 1, rotation_id: 1 } }
  ).toArray();
  const existingBases = new Set(bases.map((b) => `${b.cycle_id}|${b.bbs_id}|${b.rotation_id}`));

  return scores.filter((s) => !s.is_differential || existingBases.has(baseKeyOf(s)));
};

const bestOf = (scores) => scores.reduce((best, s) => ((s.score || 0) > (best?.score || 0) ? s : best), null);
const average = (scores) => (scores.length ? Math.round(scores.reduce((sum, s) => sum + (s.score || 0), 0) / scores.length) : null);

/**
 * Historique d'un killer sur tous les cycles : records (absolu, et de la guilde si guildId),
 * moyennes cycle par cycle, et "score à battre" pour currentCycleId (le meilleur score des AUTRES
 * cycles, dans le périmètre guilde si guildId). La guilde d'un score est celle à laquelle il a été
 * saisi (score.guild_id) : on regarde ce que la guilde a réalisé, pas son roster actuel.
 */
export const getRotationHistory = async (db, rotationId, { guildId, currentCycleId } = {}) => {
  const scores = await loadComparableScores(db, { rotation_id: rotationId });

  const cycleIds = [...new Set(scores.map((s) => s.cycle_id))];
  const cycles = await db.collection('cycles')
    .find({ _id: { $in: toObjectIds(cycleIds) } }, { projection: { name: 1, year: 1, rotations: 1, created_at: 1 } })
    .toArray();
  const cycleById = new Map(cycles.map((c) => [c._id.toString(), c]));

  const guildIds = [...new Set(scores.map((s) => s.guild_id).filter(Boolean))];
  const guilds = await db.collection('guildes')
    .find({ _id: { $in: toObjectIds(guildIds) } }, { projection: { name: 1 } })
    .toArray();
  const guildNameById = new Map(guilds.map((g) => [g._id.toString(), g.name]));

  const describe = (s) => {
    if (!s || !(s.score > 0)) return null;
    const cycle = cycleById.get(s.cycle_id);
    return {
      score: s.score,
      bbs_id: s.bbs_id,
      bbs_name: s.bbs_name || null,
      guild_id: s.guild_id || null,
      guild_name: guildNameById.get(s.guild_id) || null,
      cycle_id: s.cycle_id,
      cycle_name: cycle?.name || null,
      cycle_year: cycle?.year || null,
    };
  };

  const scoped = guildId ? scores.filter((s) => s.guild_id === guildId) : scores;

  const perCycle = cycles
    .sort((a, b) => cycleTimestamp(a) - cycleTimestamp(b))
    .map((cycle) => {
      const id = cycle._id.toString();
      const cycleScores = scores.filter((s) => s.cycle_id === id);
      const guildScores = guildId ? cycleScores.filter((s) => s.guild_id === guildId) : null;
      return {
        cycle_id: id,
        cycle_name: cycle.name,
        cycle_year: cycle.year,
        average: average(cycleScores),
        count: cycleScores.length,
        guild_average: guildScores ? average(guildScores) : null,
        guild_count: guildScores ? guildScores.length : null,
      };
    });

  const currentCycleScores = currentCycleId ? scoped.filter((s) => s.cycle_id === currentCycleId) : [];
  const previousScores = currentCycleId ? scoped.filter((s) => s.cycle_id !== currentCycleId) : [];

  return {
    rotation_id: rotationId,
    absolute_record: describe(bestOf(scores)),
    guild_record: guildId ? describe(bestOf(scoped)) : null,
    record_to_beat: currentCycleId ? describe(bestOf(previousScores)) : null,
    current_cycle_best: currentCycleId ? describe(bestOf(currentCycleScores)) : null,
    per_cycle: perCycle,
  };
};

/**
 * Meilleur score de chaque compte bbs sur chaque killer (records personnels, pour la page joueur).
 * @returns {Promise<Map<string, Array>>} bbs_id -> records triés par killer
 */
export const getAccountRecords = async (db, bbsIds) => {
  if (bbsIds.length === 0) return new Map();
  const scores = await loadComparableScores(db, { bbs_id: { $in: bbsIds } });

  const bestByKey = new Map();
  const attemptsByKey = new Map();
  for (const s of scores) {
    const key = `${s.bbs_id}|${s.rotation_id}`;
    attemptsByKey.set(key, (attemptsByKey.get(key) || 0) + 1);
    if ((s.score || 0) > (bestByKey.get(key)?.score || 0)) bestByKey.set(key, s);
  }

  const rotationIds = [...new Set([...bestByKey.values()].map((s) => s.rotation_id))];
  const cycleIds = [...new Set([...bestByKey.values()].map((s) => s.cycle_id))];
  const [rotations, cycles] = await Promise.all([
    db.collection('rotations').find({ _id: { $in: toObjectIds(rotationIds) } }).toArray(),
    db.collection('cycles').find({ _id: { $in: toObjectIds(cycleIds) } }, { projection: { name: 1, year: 1 } }).toArray(),
  ]);
  const rotationById = new Map(rotations.map((r) => [r._id.toString(), r]));
  const cycleById = new Map(cycles.map((c) => [c._id.toString(), c]));

  const recordsByAccount = new Map(bbsIds.map((id) => [id, []]));
  for (const [key, s] of bestByKey) {
    const rotation = rotationById.get(s.rotation_id);
    const cycle = cycleById.get(s.cycle_id);
    recordsByAccount.get(s.bbs_id)?.push({
      rotation_id: s.rotation_id,
      killer: rotation?.killer || null,
      attack: rotation?.attack || null,
      alteration: rotation?.alteration || null,
      score: s.score,
      cycle_id: s.cycle_id,
      cycle_name: cycle?.name || null,
      cycle_year: cycle?.year || null,
      attempts: attemptsByKey.get(key),
    });
  }
  for (const records of recordsByAccount.values()) {
    records.sort((a, b) => (a.killer || '').localeCompare(b.killer || '') || (a.attack || '').localeCompare(b.attack || ''));
  }
  return recordsByAccount;
};

/**
 * Parmi des scores tout juste insérés, retrouve ceux qui battent le meilleur score précédent du
 * même compte sur le même killer (cycles précédents uniquement). Le premier score jamais saisi
 * sur un killer n'est pas un record (rien à battre), et un score non comparable non plus.
 */
export const findNewRecords = async (db, insertedScores) => {
  const candidates = insertedScores.filter((s) => s.bbs_id && s.rotation_id && s.cycle_id && (s.score || 0) > 0);
  if (candidates.length === 0) return [];

  const comparable = await loadComparableScores(db, {
    bbs_id: { $in: [...new Set(candidates.map((s) => s.bbs_id))] },
    rotation_id: { $in: [...new Set(candidates.map((s) => s.rotation_id))] },
  });

  const records = [];
  for (const candidate of candidates) {
    const sameKiller = comparable.filter((s) => s.bbs_id === candidate.bbs_id && s.rotation_id === candidate.rotation_id);
    const current = sameKiller.find((s) => s.cycle_id === candidate.cycle_id);
    if (!current) continue; // non comparable (différentiel sans score de base)

    const previousBest = bestOf(sameKiller.filter((s) => s.cycle_id !== candidate.cycle_id));
    if (!previousBest || !(current.score > previousBest.score)) continue;

    records.push({
      bbs_id: candidate.bbs_id,
      bbs_name: current.bbs_name || candidate.bbs_name || null,
      guild_id: current.guild_id || candidate.guild_id || null,
      rotation_id: candidate.rotation_id,
      cycle_id: candidate.cycle_id,
      previous_score: previousBest.score,
      new_score: current.score,
    });
  }
  return records;
};

/**
 * Détecte les records parmi des scores tout juste insérés et envoie un message groupé par guilde
 * (salon général, à défaut salon chefs). Ne lève jamais : un échec de détection/notification ne
 * doit pas faire échouer la saisie des scores.
 * @returns {Promise<number>} nombre de records détectés
 */
export const notifyPersonalRecords = async (db, insertedScores) => {
  try {
    const records = await findNewRecords(db, insertedScores);
    if (records.length === 0) return 0;

    const rotationIds = [...new Set(records.map((r) => r.rotation_id))];
    const rotations = await db.collection('rotations').find({ _id: { $in: toObjectIds(rotationIds) } }).toArray();
    const rotationById = new Map(rotations.map((r) => [r._id.toString(), r]));

    const byGuild = new Map();
    for (const record of records) {
      if (!record.guild_id) continue;
      if (!byGuild.has(record.guild_id)) byGuild.set(record.guild_id, []);
      byGuild.get(record.guild_id).push(record);
    }

    for (const [guildId, guildRecords] of byGuild) {
      if (!ObjectId.isValid(guildId)) continue;
      const guild = await db.collection('guildes').findOne({ _id: new ObjectId(guildId) });
      const channelId = guild?.discord_general_channel_id || guild?.discord_channel_id;
      if (!channelId) continue;

      const cycleIds = [...new Set(guildRecords.map((r) => r.cycle_id))];
      const cycle = ObjectId.isValid(cycleIds[0])
        ? await db.collection('cycles').findOne({ _id: new ObjectId(cycleIds[0]) }, { projection: { name: 1 } })
        : null;

      await notifyDiscord('personal_record', {
        guild_name: guild.name || '',
        cycle_name: cycle?.name || '',
        records: guildRecords.map((r) => ({
          pseudo: r.bbs_name || r.bbs_id,
          killer: rotationById.get(r.rotation_id)?.killer || '',
          attack: rotationById.get(r.rotation_id)?.attack || '',
          previous_score: r.previous_score,
          new_score: r.new_score,
        })),
      }, channelId);
    }

    return records.length;
  } catch (err) {
    logger.error('[killerRecords] Erreur détection/notification des records (non bloquant):', err.message);
    return 0;
  }
};
