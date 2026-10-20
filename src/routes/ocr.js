import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireScoresAccess, canManageGuild } from '../middleware/auth.js';
import { processBatchScreenshots, SCREENSHOTTER_CONFIGS } from '../utils/ocrProcessor.js';
import { computeDifferential } from '../services/scoreDifferential.js';
import { notifyPersonalRecords } from '../services/killerRecords.js';
import { recordScoreChange } from '../services/scoreHistory.js';
import { notifyAchievementUnlocks } from '../services/achievementAnnouncements.js';
import { findBestMatch, getUserDisplayName } from '../utils/nameMatching.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { getGuildAccountRoster, resolveScoreAccounts } from '../utils/bbsAccounts.js';
import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import { rejectLockedCycles } from '../services/scoreLock.js';

const router = express.Router();

/**
 * GET /api/ocr/screenshotters
 * Available screenshotter profiles (no auth required)
 */
router.get('/screenshotters', (req, res) => {
  const screenshotters = Object.entries(SCREENSHOTTER_CONFIGS).map(([id, config]) => ({
    id,
    label: config.label
  }));
  res.json({ success: true, data: screenshotters });
});

router.use(requireDb);
router.use(requireScoresAccess);

/**
 * POST /api/ocr/batch-guild-ranking
 * Processes a batch of guild ranking screenshots
 * Body: {
 *   guild_id: string,
 *   cycle_id: string,
 *   rotation_id: string,
 *   screenshotter_id: string,
 *   screenshots: Array<{ data: base64, filename: string }>
 * }
 */
router.post('/batch-guild-ranking', async (req, res) => {
  try {
    const { guild_id, cycle_id, rotation_id, screenshotter_id, screenshots } = req.body;
    
    if (!guild_id || !cycle_id || !rotation_id || !screenshotter_id) {
      return res.status(400).json({
        success: false,
        message: 'guild_id, cycle_id, rotation_id et screenshotter_id sont requis'
      });
    }

    if (!canManageGuild(req.user, guild_id)) {
      return res.status(403).json({ success: false, message: 'Accès refusé à cette guilde' });
    }
    
    if (!screenshots || !Array.isArray(screenshots) || screenshots.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Au moins un screenshot est requis'
      });
    }
    
    if (screenshots.length > 10) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 10 screenshots par batch'
      });
    }
    
    const guild = await req.db.collection('guildes').findOne({ 
      _id: new ObjectId(guild_id) 
    });
    
    if (!guild) {
      return res.status(404).json({
        success: false,
        message: 'Guilde non trouvée'
      });
    }
    
    // bbs accounts (main or alts) attached to the guild, one row per account rather than per user, so
    // matching can target a specific alt.
    const guildMembers = await getGuildAccountRoster(req.db, guild_id);

    if (guildMembers.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Aucun membre dans cette guilde'
      });
    }
    
    // OCR with the predefined zones
    const ocrResults = await processBatchScreenshots(screenshots, screenshotter_id);
    
    // Match the detected names with the guild members
    const matchedResults = await Promise.all(ocrResults.map(async (screenshot) => {
      if (!screenshot.success) {
        return screenshot;
      }
      
      const matchedPlayers = screenshot.players.map(player => {
        const match = findBestMatch(player.detectedName, guildMembers);
        
        return {
          ...player,
          matching: {
            bestMatch: match.user ? {
              _id: match.user._id.toString(),
              user_id: match.user.user_id,
              bbs_id: match.user.bbs_id,
              bbs_name: match.user.bbs_name,
              global_name: match.user.global_name,
              avatar: match.user.avatar,
              confidence: match.confidence,
              autoSelected: match.confidence > 0.80
            } : null,
            alternatives: match.alternatives.map(alt => ({
              _id: alt.user._id.toString(),
              user_id: alt.user.user_id,
              bbs_id: alt.user.bbs_id,
              bbs_name: alt.user.bbs_name,
              global_name: alt.user.global_name,
              confidence: alt.confidence
            }))
          },
          needsReview: !match.user || match.confidence < 0.80 || !player.hasValidScore
        };
      });
      
      // Screenshot thumbnail
      let thumbnail = null;
      try {
        const base64Data = screenshots[screenshot.index].data.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const thumbnailBuffer = await sharp(buffer)
          .resize(200, null, { fit: 'inside' })
          .jpeg({ quality: 70 })
          .toBuffer();
        thumbnail = `data:image/jpeg;base64,${thumbnailBuffer.toString('base64')}`;
      } catch (error) {
        logger.error('Erreur génération thumbnail:', error);
      }
      
      return {
        ...screenshot,
        thumbnail,
        players: matchedPlayers
      };
    }));
    
    const totalScreenshots = matchedResults.length;
    const successfulScreenshots = matchedResults.filter(s => s.success).length;
    const totalPlayersDetected = matchedResults.reduce(
      (sum, s) => sum + (s.players?.length || 0), 
      0
    );
    const autoMatched = matchedResults.reduce(
      (sum, s) => sum + (s.players?.filter(p => !p.needsReview).length || 0),
      0
    );
    const needsReview = matchedResults.reduce(
      (sum, s) => sum + (s.players?.filter(p => p.needsReview).length || 0),
      0
    );
    
    res.json({
      success: true,
      data: {
        guild: {
          _id: guild._id.toString(),
          name: guild.name
        },
        cycle_id,
        rotation_id,
        screenshots: matchedResults,
        summary: {
          totalScreenshots,
          successfulScreenshots,
          totalPlayersDetected,
          autoMatched,
          needsReview
        }
      }
    });
    
  } catch (error) {
    logger.error('❌ Erreur route OCR:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du traitement OCR',
      error: error.message
    });
  }
});

/**
 * POST /api/ocr/submit-batch
 * Submits the scores validated after OCR review, with the differential computation
 * Body: {
 *   guild_id: string,
 *   cycle_id: string,
 *   rotation_id: string,
 *   scores: Array<{ user_id: string, raw_score: number, screenshot_index: number }>
 * }
 */
router.post('/submit-batch', async (req, res) => {
  try {
    const { guild_id, cycle_id, rotation_id, scores } = req.body;
    
    if (!guild_id || !cycle_id || !rotation_id || !scores || !Array.isArray(scores)) {
      return res.status(400).json({
        success: false,
        message: 'guild_id, cycle_id, rotation_id et scores sont requis'
      });
    }

    if (!canManageGuild(req.user, guild_id)) {
      return res.status(403).json({ success: false, message: 'Accès refusé à cette guilde' });
    }
    if (await rejectLockedCycles(req, res, [cycle_id])) return;
    
    if (scores.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Aucun score à soumettre'
      });
    }
    
    // The cycle gives the rotation order
    const cycle = await req.db.collection('cycles').findOne({
      _id: new ObjectId(cycle_id)
    });
    
    if (!cycle) {
      return res.status(400).json({
        success: false,
        message: 'Cycle non trouvé'
      });
    }
    
    const rotationIndex = cycle.rotations.findIndex(r => r.rotation_id === rotation_id);
    
    if (rotationIndex === -1) {
      return res.status(400).json({
        success: false,
        message: 'Rotation non trouvée dans ce cycle'
      });
    }
    
    const insertedScores = [];
    // Scores actually created by this submission (the upsert may also update an existing score): the
    // only personal record candidates, so resubmitting a processed screenshot does not celebrate again.
    const newlyCreatedScores = [];
    const errors = [];

    // Each bbs_id must belong to the target user_id and guild (best effort: scores without a valid
    // bbs_id are rejected individually below)
    let accountMap = new Map();
    try {
      accountMap = await resolveScoreAccounts(
        req.db,
        scores.filter(s => s.user_id && s.bbs_id).map(s => ({ user_id: s.user_id, bbs_id: s.bbs_id, guild_id }))
      );
    } catch (ownershipErr) {
      return res.status(400).json({ success: false, message: ownershipErr.message });
    }

    // Insert each score with the differential computation
    for (const scoreData of scores) {
      try {
        const { user_id, bbs_id, raw_score, screenshot_index } = scoreData;

        if (!user_id || !bbs_id || raw_score === undefined) {
          errors.push({
            user_id,
            error: 'Données manquantes (user_id, bbs_id et raw_score requis)'
          });
          continue;
        }

        const rawScoreInt = parseInt(raw_score);
        let previousRawScore;

        if (rotationIndex > 0 && rotationIndex % 2 === 1) {
          const previousRotationId = cycle.rotations[rotationIndex - 1].rotation_id;
          // bbs_id only (not user_id): a transferred account keeps its old scores under another user_id, so
          // filtering on it too would miss the base score of the differential.
          const previousScore = await req.db.collection('scores').findOne({
            bbs_id,
            cycle_id,
            rotation_id: previousRotationId
          });
          if (previousScore?.raw_score !== undefined) {
            previousRawScore = previousScore.raw_score;
          }
        }

        const { score: finalScore, isDifferential } = computeDifferential(rawScoreInt, rotationIndex, previousRawScore);
        const account = accountMap.get(`${user_id}-${bbs_id}`);

        const scoreDocument = {
          user_id,
          bbs_id,
          bbs_name: account?.bbs_name || null,
          cycle_id,
          rotation_id,
          guild_id,
          raw_score: rawScoreInt,
          score: finalScore,
          is_differential: isDifferential,
          created_at: new Date(),
          updated_at: new Date(),
          created_by: req.user._id?.toString() || req.user.discord_id,
          source: 'ocr',
          screenshot_index
        };

        // Upsert keyed by bbs_id only (the account identity): $set brings user_id up to date even when the
        // existing document still holds the previous one.
        const previousDocument = await req.db.collection('scores').findOne({ bbs_id, cycle_id, rotation_id });
        const upsertResult = await req.db.collection('scores').updateOne(
          {
            bbs_id,
            cycle_id,
            rotation_id
          },
          {
            $set: scoreDocument
          },
          { upsert: true }
        );
        if (upsertResult.upsertedCount > 0) newlyCreatedScores.push(scoreDocument);
        await recordScoreChange(req.db, {
          action: previousDocument ? 'update' : 'create',
          source: 'ocr',
          scoreId: previousDocument?._id || upsertResult.upsertedId,
          before: previousDocument,
          after: scoreDocument,
          user: req.user,
        });

        insertedScores.push({
          user_id,
          bbs_id,
          bbs_name: scoreDocument.bbs_name,
          raw_score: rawScoreInt,
          score: finalScore,
          is_differential: isDifferential
        });

      } catch (error) {
        logger.error(`Erreur insertion score pour ${scoreData.user_id}:`, error);
        errors.push({
          user_id: scoreData.user_id,
          error: error.message
        });
      }
    }
    
    // Discord notification (non-blocking)
    try {
      const userIds = [...new Set(insertedScores.map(s => s.user_id))];
      const users = await req.db.collection('users').find({
        _id: { $in: userIds.map(id => new ObjectId(id)) }
      }, { projection: { _id: 1, global_name: 1, username: 1, bbs_name: 1 } }).toArray();
      const userMap = new Map(users.map(u => [u._id.toString(), u]));

      const guild = await req.db.collection('guildes').findOne({ _id: new ObjectId(guild_id) });
      const guildName = guild?.name || '';
      const guildChannelId = guild?.discord_channel_id || '';
      const guildGeneralChannelId = guild?.discord_general_channel_id || '';

      const rotation = cycle.rotations[rotationIndex];
      const killer = rotation?.killer || '';
      const attack = rotation?.attack || '';

      const sortedForNotif = [...insertedScores].sort((a, b) => b.score - a.score);
      const scoresForNotif = sortedForNotif.map((s, i) => {
        const user = userMap.get(s.user_id);
        const pseudo = s.bbs_name || getUserDisplayName(user, s.user_id);
        return { rank: i + 1, pseudo, score: s.score, raw_score: s.raw_score };
      });

      let submittedBy = 'Inconnu';
      if (req.user?._id) {
        const submitter = await req.db.collection('users').findOne(
          { _id: new ObjectId(req.user._id) },
          { projection: { bbs_name: 1, global_name: 1, username: 1 } }
        );
        submittedBy = getUserDisplayName(submitter);
      }

      await notifyDiscord('scores', {
        submitted_by: submittedBy,
        guild_name: guildName,
        cycle_name: cycle.name || '',
        killer,
        attack,
        scores: scoresForNotif,
        summary: `${insertedScores.length} scores via OCR (${errors.length} erreurs)`,
        source: 'ocr'
      }, guildChannelId);

      // Automatic podium capture (image) to the guild's members channel, in addition to the text summary
      // sent to the leaders channel above; same trigger as the manual bulk entry (scores/bulk.js).
      if (process.env.FRONTEND_URL && guildName && rotation?.position !== undefined) {
        const cycleSlug = `${(cycle.name || '').toLowerCase().replace(/\s+/g, '-')}-${cycle.year}`;
        const captureUrl = `${process.env.FRONTEND_URL.replace(/\/$/, '')}/podium?capture=1&mode=rotation`
          + `&cycle_name=${encodeURIComponent(cycleSlug)}&rotation=${rotation.position}&guild_name=${encodeURIComponent(guildName)}`;

        await notifyDiscord('podium_snapshot', {
          guild_name: guildName,
          cycle_name: cycle.name || '',
          killer,
          attack,
          podium_url: captureUrl,
        }, guildGeneralChannelId || guildChannelId);
      }
    } catch (notifErr) {
      logger.error('[ocr/submit-batch] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    // Personal records beaten (one message per guild; never throws)
    await notifyPersonalRecords(req.db, newlyCreatedScores);
    await notifyAchievementUnlocks(req.db, insertedScores.map((s) => ({ bbs_id: s.bbs_id, guild_id })));

    res.json({
      success: true,
      data: {
        inserted: insertedScores.length,
        errorsCount: errors.length,
        insertedScores,
        errors,
        rotation_info: {
          index: rotationIndex,
          is_differential: rotationIndex % 2 === 1
        }
      }
    });
    
  } catch (error) {
    logger.error('❌ Erreur soumission batch:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la soumission des scores',
      error: error.message
    });
  }
});

export default router;
