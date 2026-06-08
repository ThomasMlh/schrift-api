import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireScoresAccess } from '../middleware/auth.js';
import { processBatchScreenshots, SCREENSHOTTER_CONFIGS } from '../utils/ocrProcessor.js';
import { computeDifferential } from '../services/scoreDifferential.js';
import { findBestMatch, getUserDisplayName } from '../utils/nameMatching.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import sharp from 'sharp';

const router = express.Router();

/**
 * GET /api/ocr/screenshotters
 * Retourne la liste des screenshotters disponibles (pas besoin d'auth)
 */
router.get('/screenshotters', (req, res) => {
  const screenshotters = Object.entries(SCREENSHOTTER_CONFIGS).map(([id, config]) => ({
    id,
    label: config.label
  }));
  res.json({ success: true, data: screenshotters });
});

// Middleware pour toutes les autres routes OCR
router.use(requireDb);
router.use(requireScoresAccess);

/**
 * POST /api/ocr/batch-guild-ranking
 * Traite un batch de screenshots de classement guilde
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
    
    // Validations
    if (!guild_id || !cycle_id || !rotation_id || !screenshotter_id) {
      return res.status(400).json({
        success: false,
        message: 'guild_id, cycle_id, rotation_id et screenshotter_id sont requis'
      });
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
    
    // Vérifier que la guilde existe
    const guild = await req.db.collection('guildes').findOne({ 
      _id: new ObjectId(guild_id) 
    });
    
    if (!guild) {
      return res.status(404).json({
        success: false,
        message: 'Guilde non trouvée'
      });
    }
    
    // Récupérer les membres de la guilde
    const guildMembers = await req.db.collection('users').find({
      guilde_id: guild_id
    }).toArray();
    
    if (guildMembers.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Aucun membre dans cette guilde'
      });
    }
    
    // Traiter les screenshots avec OCR (zones prédéfinies)
    const ocrResults = await processBatchScreenshots(screenshots, screenshotter_id);
    
    // Pour chaque screenshot, matcher les noms détectés avec les membres
    const matchedResults = await Promise.all(ocrResults.map(async (screenshot) => {
      if (!screenshot.success) {
        return screenshot;
      }
      
      const matchedPlayers = screenshot.players.map(player => {
        // Matcher le nom avec les membres de la guilde
        const match = findBestMatch(player.detectedName, guildMembers);
        
        return {
          ...player,
          matching: {
            bestMatch: match.user ? {
              _id: match.user._id.toString(),
              bbs_name: match.user.bbs_name,
              global_name: match.user.global_name,
              avatar: match.user.avatar,
              confidence: match.confidence,
              autoSelected: match.confidence > 0.80
            } : null,
            alternatives: match.alternatives.map(alt => ({
              _id: alt.user._id.toString(),
              bbs_name: alt.user.bbs_name,
              global_name: alt.user.global_name,
              confidence: alt.confidence
            }))
          },
          needsReview: !match.user || match.confidence < 0.80 || !player.hasValidScore
        };
      });
      
      // Générer une miniature du screenshot
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
        console.error('Erreur génération thumbnail:', error);
      }
      
      return {
        ...screenshot,
        thumbnail,
        players: matchedPlayers
      };
    }));
    
    // Calculer les statistiques
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
    console.error('❌ Erreur route OCR:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors du traitement OCR',
      error: error.message
    });
  }
});

/**
 * POST /api/ocr/submit-batch
 * Soumet les scores validés après vérification OCR avec calcul différentiel
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
    
    if (scores.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Aucun score à soumettre'
      });
    }
    
    // Récupérer le cycle pour avoir l'ordre des rotations
    const cycle = await req.db.collection('cycles').findOne({
      _id: new ObjectId(cycle_id)
    });
    
    if (!cycle) {
      return res.status(400).json({
        success: false,
        message: 'Cycle non trouvé'
      });
    }
    
    // Trouver l'index de la rotation actuelle
    const rotationIndex = cycle.rotations.findIndex(r => r.rotation_id === rotation_id);
    
    if (rotationIndex === -1) {
      return res.status(400).json({
        success: false,
        message: 'Rotation non trouvée dans ce cycle'
      });
    }
    
    const insertedScores = [];
    const errors = [];
    
    // Insérer chaque score avec calcul différentiel
    for (const scoreData of scores) {
      try {
        const { user_id, raw_score, screenshot_index } = scoreData;
        
        if (!user_id || raw_score === undefined) {
          errors.push({
            user_id,
            error: 'Données manquantes'
          });
          continue;
        }
        
        const rawScoreInt = parseInt(raw_score);
        let previousRawScore;

        if (rotationIndex > 0 && rotationIndex % 2 === 1) {
          const previousRotationId = cycle.rotations[rotationIndex - 1].rotation_id;
          const previousScore = await req.db.collection('scores').findOne({
            user_id,
            cycle_id,
            rotation_id: previousRotationId
          });
          if (previousScore?.raw_score !== undefined) {
            previousRawScore = previousScore.raw_score;
          }
        }

        const { score: finalScore, isDifferential } = computeDifferential(rawScoreInt, rotationIndex, previousRawScore);
        
        // Créer le document score
        const scoreDocument = {
          user_id,
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
        
        // Upsert (insert ou update si existe déjà)
        const result = await req.db.collection('scores').updateOne(
          {
            user_id,
            cycle_id,
            rotation_id
          },
          {
            $set: scoreDocument
          },
          { upsert: true }
        );
        
        insertedScores.push({
          user_id,
          raw_score: rawScoreInt,
          score: finalScore,
          is_differential: isDifferential
        });
        
      } catch (error) {
        console.error(`Erreur insertion score pour ${scoreData.user_id}:`, error);
        errors.push({
          user_id: scoreData.user_id,
          error: error.message
        });
      }
    }
    
    // --- Notification Discord (non bloquante) ---
    try {
      const userIds = [...new Set(insertedScores.map(s => s.user_id))];
      const users = await req.db.collection('users').find({
        _id: { $in: userIds.map(id => new ObjectId(id)) }
      }, { projection: { _id: 1, global_name: 1, username: 1, bbs_name: 1 } }).toArray();
      const userMap = new Map(users.map(u => [u._id.toString(), u]));

      const guild = await req.db.collection('guildes').findOne({ _id: new ObjectId(guild_id) });
      const guildName = guild?.name || '';
      const guildChannelId = guild?.discord_channel_id || '';

      const rotation = cycle.rotations[rotationIndex];
      const killer = rotation?.killer || '';
      const attack = rotation?.attack || '';

      const sortedForNotif = [...insertedScores].sort((a, b) => b.score - a.score);
      const scoresForNotif = sortedForNotif.map((s, i) => {
        const user = userMap.get(s.user_id);
        const pseudo = getUserDisplayName(user, s.user_id);
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

      notifyDiscord('scores', {
        submitted_by: submittedBy,
        guild_name: guildName,
        cycle_name: cycle.name || '',
        killer,
        attack,
        scores: scoresForNotif,
        summary: `${insertedScores.length} scores via OCR (${errors.length} erreurs)`,
        source: 'ocr'
      }, guildChannelId);
    } catch (notifErr) {
      console.error('[ocr/submit-batch] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({
      success: true,
      data: {
        inserted: insertedScores.length,
        errors: errors.length,
        insertedScores,
        errors,
        rotation_info: {
          index: rotationIndex,
          is_differential: rotationIndex % 2 === 1
        }
      }
    });
    
  } catch (error) {
    console.error('❌ Erreur soumission batch:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la soumission des scores',
      error: error.message
    });
  }
});

export default router;
