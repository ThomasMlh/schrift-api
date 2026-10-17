import { ObjectId } from 'mongodb';
import { listUnlockedTiers, invalidateAchievementsCache, TIER_LABELS_FR } from './achievements.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * Discord announcements of gold and platinum achievement tiers unlocked by a score entry.
 *
 * Achievements are recomputed from scores; to know what is NEW, each announced tier is stored in
 * `achievement_unlocks` (one document per account, achievement and tier). On the first run, every
 * tier already earned is recorded without an announcement, so the whole history is not published
 * at once.
 */

export const ANNOUNCED_TIERS = ['gold', 'platinum'];
const SEED_MARKER = { _id: 'achievement_unlocks_seeded' };

const ensureSeeded = async (db) => {
  if (await db.collection('app_settings').findOne(SEED_MARKER)) return false;
  const unlocked = await listUnlockedTiers(db, { tiers: ANNOUNCED_TIERS });
  if (unlocked.length) {
    await db.collection('achievement_unlocks').bulkWrite(unlocked.map((u) => ({
      updateOne: {
        filter: { bbs_id: u.bbs_id, code: u.code, tier: u.tier },
        update: { $setOnInsert: { unlocked_at: new Date(u.unlocked_at), announced: false, created_at: new Date() } },
        upsert: true,
      },
    })));
  }
  await db.collection('app_settings').updateOne(SEED_MARKER, { $set: { seeded_at: new Date() } }, { upsert: true });
  return true;
};

/**
 * Detects gold/platinum tiers newly unlocked by accounts with new scores and sends one message per
 * guild (general channel, falling back to the leaders channel). Never throws.
 * @returns {Promise<number>} number of tiers announced
 */
export const notifyAchievementUnlocks = async (db, insertedScores) => {
  try {
    const guildByAccount = new Map();
    for (const s of insertedScores) if (s.bbs_id && s.guild_id) guildByAccount.set(s.bbs_id, s.guild_id);
    if (guildByAccount.size === 0) return 0;

    invalidateAchievementsCache();
    if (await ensureSeeded(db)) return 0;

    const unlocked = await listUnlockedTiers(db, { tiers: ANNOUNCED_TIERS, bbsIds: [...guildByAccount.keys()] });
    const fresh = [];
    for (const u of unlocked) {
      const result = await db.collection('achievement_unlocks').updateOne(
        { bbs_id: u.bbs_id, code: u.code, tier: u.tier },
        { $setOnInsert: { unlocked_at: new Date(u.unlocked_at), announced: true, created_at: new Date() } },
        { upsert: true }
      );
      if (result.upsertedCount > 0) fresh.push(u);
    }
    if (fresh.length === 0) return 0;

    const byGuild = new Map();
    for (const u of fresh) {
      const guildId = guildByAccount.get(u.bbs_id);
      if (!byGuild.has(guildId)) byGuild.set(guildId, []);
      byGuild.get(guildId).push(u);
    }

    for (const [guildId, unlocks] of byGuild) {
      if (!ObjectId.isValid(guildId)) continue;
      const guild = await db.collection('guildes').findOne({ _id: new ObjectId(guildId) });
      const channelId = guild?.discord_general_channel_id || guild?.discord_channel_id;
      if (!channelId) continue;
      await notifyDiscord('achievement_unlock', {
        guild_name: guild.name || '',
        unlocks: unlocks
          .sort((a, b) => a.rarity - b.rarity)
          .map((u) => ({ pseudo: u.bbs_name || u.bbs_id, code: u.code, name: u.name, tier: u.tier, tier_label: TIER_LABELS_FR[u.tier], rarity: u.rarity })),
      }, channelId);
    }
    return fresh.length;
  } catch (err) {
    logger.error('[achievements] Erreur détection/annonce des succès (non bloquant):', err.message);
    return 0;
  }
};
