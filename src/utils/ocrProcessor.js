import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { cleanPlayerNameOCR, parseScore } from './nameMatching.js';
import { logger } from './logger.js';

/**
 * Default predefined zones (reference resolution 1371x771)
 */
const DEFAULT_ROWS = [
  { 
    name: { x: 0.38, y: 0.22, w: 0.095, h: 0.045 },
    score: { x: 0.695, y: 0.285, w: 0.20, h: 0.045 }
  },
  { 
    name: { x: 0.38, y: 0.375, w: 0.095, h: 0.045 },
    score: { x: 0.695, y: 0.445, w: 0.20, h: 0.045 }
  },
  { 
    name: { x: 0.38, y: 0.53, w: 0.095, h: 0.045 },
    score: { x: 0.695, y: 0.603, w: 0.20, h: 0.045 }
  },
  { 
    name: { x: 0.38, y: 0.69, w: 0.095, h: 0.045 },
    score: { x: 0.695, y: 0.755, w: 0.20, h: 0.045 }
  },
  { 
    name: { x: 0.38, y: 0.845, w: 0.095, h: 0.045 },
    score: { x: 0.695, y: 0.915, w: 0.20, h: 0.045 }
  }
];

const ROKUDO_ROWS = [
  { 
    name: { x: 0.435, y: 0.26, w: 0.095, h: 0.045 },
    score: { x: 0.65, y: 0.32, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.435, y: 0.39, w: 0.095, h: 0.045 },
    score: { x: 0.65, y: 0.455, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.435, y: 0.528, w: 0.095, h: 0.045 },
    score: { x: 0.65, y: 0.585, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.435, y: 0.66, w: 0.095, h: 0.045 },
    score: { x: 0.65, y: 0.725, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.435, y: 0.79, w: 0.095, h: 0.045 },
    score: { x: 0.65, y: 0.855, w: 0.14, h: 0.045 }
  }
];

const AS_ROWS = [
  { 
    name: { x: 0.418, y: 0.26, w: 0.095, h: 0.045 },
    score: { x: 0.63, y: 0.32, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.418, y: 0.39, w: 0.095, h: 0.045 },
    score: { x: 0.63, y: 0.455, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.418, y: 0.528, w: 0.095, h: 0.045 },
    score: { x: 0.63, y: 0.585, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.418, y: 0.66, w: 0.095, h: 0.045 },
    score: { x: 0.63, y: 0.725, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.418, y: 0.79, w: 0.095, h: 0.045 },
    score: { x: 0.63, y: 0.855, w: 0.14, h: 0.045 }
  }
];

const LUMILA_ROWS = [
  { 
    name: { x: 0.418, y: 0.148, w: 0.095, h: 0.045 },
    score: { x: 0.63, y: 0.22, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.418, y: 0.30, w: 0.095, h: 0.045 },
    score: { x: 0.63, y: 0.37, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.418, y: 0.455, w: 0.095, h: 0.045 },
    score: { x: 0.63, y: 0.525, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.418, y: 0.605, w: 0.095, h: 0.045 },
    score: { x: 0.63, y: 0.675, w: 0.14, h: 0.045 }
  },
  { 
    name: { x: 0.418, y: 0.76, w: 0.095, h: 0.045 },
    score: { x: 0.63, y: 0.83, w: 0.14, h: 0.045 }
  }
];
/**
 * Zone configurations per screenshotter.
 * Each person has their own coordinates, calibrated for their device/resolution. Coordinates are
 * relative (0-1) to the image size.
 *
 * To calibrate: open the OCR Debug page, select the profile, then adjust the values here until the
 * rectangles are correctly placed.
 */
export const SCREENSHOTTER_CONFIGS = {
  stormisi: {
    label: 'Stormisi',
    rows: DEFAULT_ROWS
  },
  rokudo: {
    label: 'Rokudo',
    rows: ROKUDO_ROWS
  },
  lumila: {
    label: 'Lumila',
    rows: LUMILA_ROWS
  },
  as_nodt: {
    label: 'As Nodt',
    rows: AS_ROWS
  },
  karasu: {
    label: 'Karasu',
    rows: DEFAULT_ROWS
  },
  fosro: {
    label: 'Fosro',
    rows: DEFAULT_ROWS
  },
  gogeta: {
    label: 'Gogeta',
    rows: DEFAULT_ROWS
  },
  shiro: {
    label: 'Shiro',
    rows: DEFAULT_ROWS
  }
};

/**
 * Zones (PLAYER_ROWS) of a screenshotter
 * @param {string} screenshotterId - Screenshotter id
 * @returns {{ rows: Array, label: string }}
 */
export const getScreenshotterConfig = (screenshotterId) => {
  const config = SCREENSHOTTER_CONFIGS[screenshotterId];
  if (!config) {
    logger.warn(`⚠️ Screenshotter inconnu: "${screenshotterId}", utilisation config par défaut`);
    return { label: 'Défaut', rows: DEFAULT_ROWS };
  }
  return config;
}

/**
 * Converts a base64 image into a buffer
 */
const base64ToBuffer = (base64String) => {
  // Strip the data:image/...;base64, prefix when present
  const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

/**
 * Preprocesses an image region to improve OCR:
 * - crop and upscale (2x) for better recognition
 * - greyscale
 * - strong contrast increase
 * - binarization
 */
const preprocessRegion = async (imageBuffer, region, imageWidth, imageHeight) => {
  try {
    const left = Math.round(region.x * imageWidth);
    const top = Math.round(region.y * imageHeight);
    const width = Math.round(region.w * imageWidth);
    const height = Math.round(region.h * imageHeight);
    
    const processedBuffer = await sharp(imageBuffer)
      .extract({ left, top, width, height })
      .resize(width * 2, height * 2, { kernel: 'lanczos3' }) // Upscale 2x
      .greyscale()
      .linear(1.5, -(128 * 0.5)) // Increase contrast
      .normalize() // Normalize levels
      .threshold(140) // Binarize with a higher threshold
      .toBuffer();
    
    return processedBuffer;
  } catch (error) {
    logger.error('Erreur prétraitement région:', error);
    throw error;
  }
}

/**
 * Runs OCR on a region with tuned parameters
 */
const performOCR = async (imageBuffer, lang = 'eng', config = {}) => {
  try {
    const { data: { text } } = await Tesseract.recognize(imageBuffer, lang, {
      logger: m => {
        if (m.status === 'recognizing text') {
          logger.info(`OCR progress: ${Math.round(m.progress * 100)}%`);
        }
      },
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE, // Single line of text
      tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY, // Best engine
      ...config
    });
    
    return text.trim();
  } catch (error) {
    logger.error('Erreur OCR:', error);
    return null;
  }
}

/**
 * Whether a row contains text (is not empty)
 */
const hasVisibleText = async (imageBuffer, region, imageWidth, imageHeight) => {
  try {
    const processedBuffer = await preprocessRegion(imageBuffer, region, imageWidth, imageHeight);
    
    const stats = await sharp(processedBuffer).stats();
    
    // Too uniform (all white or all black): no text
    const variance = stats.channels[0].stdev;
    return variance > 10; // Tunable threshold
  } catch (error) {
    return false;
  }
}

/**
 * Processes a BBS ranking screenshot and extracts names and scores
 * @param {string} base64Image - Base64 image
 * @param {string} [screenshotterId] - Screenshotter id (selects its zone configuration)
 * @returns {Promise<Array>} Detected players with name and score
 */
export const processGuildRankingScreenshot = async (base64Image, screenshotterId) => {
  try {
    const config = getScreenshotterConfig(screenshotterId);
    const playerRows = config.rows;
    
    logger.info(`🔍 Début du traitement OCR (profil: ${config.label})...`);
    
    const imageBuffer = base64ToBuffer(base64Image);
    
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;
    
    logger.info(`📐 Dimensions image: ${width}x${height}`);
    
    const results = [];
    
    // Process each row (at most 5 players per screenshot)
    for (let i = 0; i < playerRows.length; i++) {
      const row = playerRows[i];
      
      logger.info(`\n🔎 Traitement ligne ${i + 1}...`);
      
      const hasContent = await hasVisibleText(imageBuffer, row.name, width, height);
      
      if (!hasContent) {
        logger.info(`⏭️  Ligne ${i + 1} vide, arrêt du traitement`);
        break; // Stop at an empty row (end of the ranking)
      }
      
      // Player name OCR (eng+jpn+chi_sim to support kanji/kana/hanzi names)
      const nameBuffer = await preprocessRegion(imageBuffer, row.name, width, height);
      const nameText = await performOCR(nameBuffer, 'eng+jpn+chi_sim');
      
      // Score OCR
      const scoreBuffer = await preprocessRegion(imageBuffer, row.score, width, height);
      const scoreText = await performOCR(scoreBuffer, 'eng', {
        tessedit_char_whitelist: '0123456789,'
      });
      
      logger.info(`  👤 Nom détecté: "${nameText}"`);
      logger.info(`  🎯 Score brut: "${scoreText}"`);
      
      // Clean and parse
      const cleanedName = cleanPlayerNameOCR(nameText);
      const parsedScore = parseScore(scoreText);
      
      logger.info(`  ✨ Nom nettoyé: "${cleanedName}"`);
      logger.info(`  💯 Score parsé: ${parsedScore.value || 'ERREUR'}`);
      
      results.push({
        lineNumber: i + 1,
        detectedName: cleanedName,
        rawNameText: nameText,
        score: parsedScore.value,
        rawScoreText: scoreText,
        scoreError: parsedScore.error,
        hasValidName: cleanedName.length > 0,
        hasValidScore: parsedScore.value !== null
      });
    }
    
    logger.info(`\n✅ Traitement terminé: ${results.length} ligne(s) détectée(s)`);
    
    return results;
  } catch (error) {
    logger.error('❌ Erreur lors du traitement OCR:', error);
    throw new Error(`Erreur OCR: ${error.message}`);
  }
}

/**
 * Processes several screenshots in parallel
 * @param {Array} screenshots - Screenshots to process
 * @param {string} [screenshotterId] - Screenshotter id
 */
export const processBatchScreenshots = async (screenshots, screenshotterId) => {
  const results = await Promise.all(
    screenshots.map(async (screenshot, index) => {
      try {
        logger.info(`\n📸 Screenshot ${index + 1}/${screenshots.length}`);
        const playerResults = await processGuildRankingScreenshot(screenshot.data, screenshotterId);
        
        return {
          index,
          filename: screenshot.filename,
          success: true,
          players: playerResults,
          error: null
        };
      } catch (error) {
        logger.error(`❌ Erreur screenshot ${index + 1}:`, error);
        return {
          index,
          filename: screenshot.filename,
          success: false,
          players: [],
          error: error.message
        };
      }
    })
  );
  
  return results;
}
