import express from 'express';
import sharp from 'sharp';
import { requireScoresAccess, requireDb } from '../middleware/auth.js';
import { processGuildRankingScreenshot, getScreenshotterConfig } from '../utils/ocrProcessor.js';

const router = express.Router();

// Appliquer les middlewares
router.use(requireDb);
router.use(requireScoresAccess);

/**
 * Route de debug pour visualiser les zones prédéfinies
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

    console.log(`🔍 Début traitement OCR debug (profil: ${config.label})...`);

    // Convertir base64 en buffer
    const base64Data = screenshot.data.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(base64Data, 'base64');

    // Obtenir les dimensions
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;

    console.log(`📐 Image: ${width}x${height}`);

    // Exécuter l'OCR avec zones prédéfinies
    const players = await processGuildRankingScreenshot(screenshot.data, screenshotter_id);
    
    console.log(`✅ ${players.length} joueurs détectés`);

    // Créer une image avec les zones prédéfinies marquées
    const svgElements = [];
    
    playerRows.forEach((row, i) => {
      const player = players[i];
      
      // Coordonnées absolues pour le nom
      const nameX = Math.round(row.name.x * width);
      const nameY = Math.round(row.name.y * height);
      const nameW = Math.round(row.name.w * width);
      const nameH = Math.round(row.name.h * height);
      
      // Coordonnées absolues pour le score
      const scoreX = Math.round(row.score.x * width);
      const scoreY = Math.round(row.score.y * height);
      const scoreW = Math.round(row.score.w * width);
      const scoreH = Math.round(row.score.h * height);
      
      // Rectangle pour le nom (vert)
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
      
      // Rectangle pour le score (cyan)
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

    // Appliquer les rectangles sur l'image
    const annotatedImage = await sharp(imageBuffer)
      .composite([{
        input: Buffer.from(svgOverlay),
        top: 0,
        left: 0
      }])
      .png()
      .toBuffer();

    // Créer des extraits pour chaque zone prédéfinie
    const extractedZones = [];
    
    for (let i = 0; i < playerRows.length; i++) {
      const row = playerRows[i];
      const player = players[i];
      
      // Zone nom
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
      
      // Zone score
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
    console.error('❌ Erreur debug OCR:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur lors du traitement OCR',
      error: error.message 
    });
  }
});

export default router;
