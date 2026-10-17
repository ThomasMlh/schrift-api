import express from 'express';
import sharp from 'sharp';
import { requireScoresAccess, requireDb } from '../middleware/auth.js';
import { processGuildRankingScreenshot, getScreenshotterConfig } from '../utils/ocrProcessor.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(requireDb);
router.use(requireScoresAccess);

/**
 * Debug route to visualize the predefined zones
 * POST /api/ocr/debug/visualize-zones
 * Body: { screenshot: { data, filename }, screenshotter_id: string }
 */
router.post('/visualize-zones', async (req, res) => {
  try {
    const { screenshot, screenshotter_id } = req.body;

    if (!screenshot || !screenshot.data) {
      return res.status(400).json({ 
        success: false, 
        message: 'Screenshot manquant' 
      });
    }

    const config = getScreenshotterConfig(screenshotter_id);
    const playerRows = config.rows;

    logger.info(`🔍 Début traitement OCR debug (profil: ${config.label})...`);

    const base64Data = screenshot.data.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');

    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    logger.info(`📐 Image: ${width}x${height}`);

    // OCR with the predefined zones
    const players = await processGuildRankingScreenshot(screenshot.data, screenshotter_id);
    
    logger.info(`✅ ${players.length} joueurs détectés`);

    // Image with the predefined zones drawn on it
    const svgElements = [];
    
    playerRows.forEach((row, i) => {
      const player = players[i];
      
      const nameX = Math.round(row.name.x * width);
      const nameY = Math.round(row.name.y * height);
      const nameW = Math.round(row.name.w * width);
      const nameH = Math.round(row.name.h * height);
      
      const scoreX = Math.round(row.score.x * width);
      const scoreY = Math.round(row.score.y * height);
      const scoreW = Math.round(row.score.w * width);
      const scoreH = Math.round(row.score.h * height);
      
      // Name rectangle (green)
      const nameLabel = player ? `${player.detectedName || '?'}` : `Ligne ${i + 1}`;
      svgElements.push(`
        <rect x="${nameX}" y="${nameY}" 
              width="${nameW}" height="${nameH}" 
              fill="none" stroke="lime" stroke-width="3" />
        <text x="${nameX + 5}" y="${nameY - 5}" 
              fill="lime" font-size="20" font-weight="bold" 
              style="text-shadow: 2px 2px 4px rgba(0,0,0,0.8);">
          ${nameLabel}
        </text>
      `);
      
      // Score rectangle (cyan)
      const scoreLabel = player ? `${player.score || 0}` : '—';
      svgElements.push(`
        <rect x="${scoreX}" y="${scoreY}" 
              width="${scoreW}" height="${scoreH}" 
              fill="none" stroke="cyan" stroke-width="3" />
        <text x="${scoreX + 5}" y="${scoreY - 5}" 
              fill="cyan" font-size="20" font-weight="bold"
              style="text-shadow: 2px 2px 4px rgba(0,0,0,0.8);">
          ${scoreLabel}
        </text>
      `);
    });

    const svgOverlay = `
      <svg width="${width}" height="${height}">
        ${svgElements.join('\n')}
      </svg>
    `;

    const annotatedImage = await sharp(imageBuffer)
      .composite([{
        input: Buffer.from(svgOverlay),
        top: 0,
        left: 0
      }])
      .png()
      .toBuffer();

    // Crops of each predefined zone
    const extractedZones = [];
    
    for (let i = 0; i < playerRows.length; i++) {
      const row = playerRows[i];
      const player = players[i];
      
      const nameX = Math.max(0, Math.round(row.name.x * width));
      const nameY = Math.max(0, Math.round(row.name.y * height));
      const nameW = Math.min(Math.round(row.name.w * width), width - nameX);
      const nameH = Math.min(Math.round(row.name.h * height), height - nameY);
      
      const nameExtract = await sharp(imageBuffer)
        .extract({ left: nameX, top: nameY, width: nameW, height: nameH })
        .resize(nameW * 2, nameH * 2, { kernel: 'lanczos3' })
        .greyscale()
        .linear(1.3, -(128 * 0.3))
        .normalize()
        .png()
        .toBuffer();
      
      const scoreX = Math.max(0, Math.round(row.score.x * width));
      const scoreY = Math.max(0, Math.round(row.score.y * height));
      const scoreW = Math.min(Math.round(row.score.w * width), width - scoreX);
      const scoreH = Math.min(Math.round(row.score.h * height), height - scoreY);
      
      const scoreExtract = await sharp(imageBuffer)
        .extract({ left: scoreX, top: scoreY, width: scoreW, height: scoreH })
        .resize(scoreW * 2, scoreH * 2, { kernel: 'lanczos3' })
        .greyscale()
        .linear(1.3, -(128 * 0.3))
        .normalize()
        .png()
        .toBuffer();
      
      extractedZones.push({
        index: i + 1,
        detectedName: player?.detectedName || '',
        detectedScore: player?.score || 0,
        name: `data:image/png;base64,${nameExtract.toString('base64')}`,
        score: `data:image/png;base64,${scoreExtract.toString('base64')}`
      });
    }

    res.json({
      success: true,
      data: {
        annotatedImage: `data:image/png;base64,${annotatedImage.toString('base64')}`,
        dimensions: { width, height },
        extractedZones,
        detectionMethod: 'predefined',
        playersDetected: players.length,
        screenshotter: { id: screenshotter_id, label: config.label },
        detectionInfo: {
          message: `Zones prédéfinies pour ${config.label}`,
          zones: playerRows.length
        }
      }
    });

  } catch (error) {
    logger.error('❌ Erreur debug OCR:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur lors du traitement OCR',
      error: error.message 
    });
  }
});

export default router;
