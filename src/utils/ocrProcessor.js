import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { cleanPlayerNameOCR, parseScore } from './nameMatching.js';

/**
 * Zones prédéfinies par défaut (résolution de référence 1371x771)
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
 * Configurations de zones par screenshotter
 * Chaque personne a ses propres coordonnées calibrées sur son appareil/résolution.
 * Les coordonnées sont relatives (0-1) basées sur la taille de l'image.
 * 
 * Pour calibrer : utiliser la page OCR Debug, sélectionner le profil,
 * puis ajuster les valeurs ici jusqu'à ce que les rectangles soient bien placés.
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
 * Retourne les zones (PLAYER_ROWS) pour un screenshotter donné
 * @param {string} screenshotterId - Identifiant du screenshotter
 * @returns {{ rows: Array, label: string }}
 */
export function getScreenshotterConfig(screenshotterId) {
  const config = SCREENSHOTTER_CONFIGS[screenshotterId];
  if (!config) {
    console.warn(`⚠️ Screenshotter inconnu: "${screenshotterId}", utilisation config par défaut`);
    return { label: 'Défaut', rows: DEFAULT_ROWS };
  }
  return config;
}

/**
 * Convertit une image base64 en buffer
 */
function base64ToBuffer(base64String) {
  // Enlever le préfixe data:image/...;base64, si présent
  const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

/**
 * Prétraite une région de l'image pour améliorer l'OCR
 * - Extraction et agrandissement (2x) pour meilleure reconnaissance
 * - Conversion en niveaux de gris
 * - Augmentation agressive du contraste
 * - Binarisation avec seuil adaptatif
 */
async function preprocessRegion(imageBuffer, region, imageWidth, imageHeight) {
  try {
    // Calculer les coordonnées absolues
    const left = Math.round(region.x * imageWidth);
    const top = Math.round(region.y * imageHeight);
    const width = Math.round(region.w * imageWidth);
    const height = Math.round(region.h * imageHeight);
    
    // Extraire et prétraiter la région avec upscaling pour meilleur OCR
    const processedBuffer = await sharp(imageBuffer)
      .extract({ left, top, width, height })
      .resize(width * 2, height * 2, { kernel: 'lanczos3' }) // Agrandir 2x
      .greyscale()
      .linear(1.5, -(128 * 0.5)) // Augmenter le contraste
      .normalize() // Normaliser les niveaux
      .threshold(140) // Binarisation avec seuil plus élevé
      .toBuffer();
    
    return processedBuffer;
  } catch (error) {
    console.error('Erreur prétraitement région:', error);
    throw error;
  }
}

/**
 * Effectue l'OCR sur une région spécifique avec paramètres optimisés
 */
async function performOCR(imageBuffer, lang = 'eng', config = {}) {
  try {
    const { data: { text } } = await Tesseract.recognize(imageBuffer, lang, {
      logger: m => {
        if (m.status === 'recognizing text') {
          console.log(`OCR progress: ${Math.round(m.progress * 100)}%`);
        }
      },
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE, // Une seule ligne de texte
      tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY, // Meilleur moteur
      ...config
    });
    
    return text.trim();
  } catch (error) {
    console.error('Erreur OCR:', error);
    return null;
  }
}

/**
 * Détecte si une ligne contient du texte (n'est pas vide)
 */
async function hasVisibleText(imageBuffer, region, imageWidth, imageHeight) {
  try {
    const processedBuffer = await preprocessRegion(imageBuffer, region, imageWidth, imageHeight);
    
    // Analyser les pixels pour détecter du contenu
    const stats = await sharp(processedBuffer).stats();
    
    // Si trop uniforme (tous blancs ou tous noirs), pas de texte
    const variance = stats.channels[0].stdev;
    return variance > 10; // Seuil ajustable
  } catch (error) {
    return false;
  }
}

/**
 * Traite un screenshot de classement BBS et extrait les noms et scores
 * @param {string} base64Image - Image en base64
 * @param {string} [screenshotterId] - Identifiant du screenshotter (pour charger sa config de zones)
 * @returns {Promise<Array>} Liste des joueurs détectés avec nom et score
 */
export async function processGuildRankingScreenshot(base64Image, screenshotterId) {
  try {
    const config = getScreenshotterConfig(screenshotterId);
    const playerRows = config.rows;
    
    console.log(`🔍 Début du traitement OCR (profil: ${config.label})...`);
    
    // Convertir base64 en buffer
    const imageBuffer = base64ToBuffer(base64Image);
    
    // Obtenir les dimensions de l'image
    const metadata = await sharp(imageBuffer).metadata();
    const { width, height } = metadata;
    
    console.log(`📐 Dimensions image: ${width}x${height}`);
    
    const results = [];
    
    // Traiter chaque ligne (max 5 joueurs par screenshot)
    for (let i = 0; i < playerRows.length; i++) {
      const row = playerRows[i];
      
      console.log(`\n🔎 Traitement ligne ${i + 1}...`);
      
      // Vérifier si la ligne contient du texte
      const hasContent = await hasVisibleText(imageBuffer, row.name, width, height);
      
      if (!hasContent) {
        console.log(`⏭️  Ligne ${i + 1} vide, arrêt du traitement`);
        break; // Arrêter si ligne vide (fin du classement)
      }
      
      // OCR sur le nom du joueur (eng+jpn+chi_sim pour supporter les pseudos en kanji/kana/hanzi)
      const nameBuffer = await preprocessRegion(imageBuffer, row.name, width, height);
      const nameText = await performOCR(nameBuffer, 'eng+jpn+chi_sim');
      
      // OCR sur le score
      const scoreBuffer = await preprocessRegion(imageBuffer, row.score, width, height);
      const scoreText = await performOCR(scoreBuffer, 'eng', {
        tessedit_char_whitelist: '0123456789,'
      });
      
      console.log(`  👤 Nom détecté: "${nameText}"`);
      console.log(`  🎯 Score brut: "${scoreText}"`);
      
      // Nettoyer et parser
      const cleanedName = cleanPlayerNameOCR(nameText);
      const parsedScore = parseScore(scoreText);
      
      console.log(`  ✨ Nom nettoyé: "${cleanedName}"`);
      console.log(`  💯 Score parsé: ${parsedScore.value || 'ERREUR'}`);
      
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
    
    console.log(`\n✅ Traitement terminé: ${results.length} ligne(s) détectée(s)`);
    
    return results;
  } catch (error) {
    console.error('❌ Erreur lors du traitement OCR:', error);
    throw new Error(`Erreur OCR: ${error.message}`);
  }
}

/**
 * Traite plusieurs screenshots en parallèle
 * @param {Array} screenshots - Liste des screenshots à traiter
 * @param {string} [screenshotterId] - Identifiant du screenshotter
 */
export async function processBatchScreenshots(screenshots, screenshotterId) {
  const results = await Promise.all(
    screenshots.map(async (screenshot, index) => {
      try {
        console.log(`\n📸 Screenshot ${index + 1}/${screenshots.length}`);
        const playerResults = await processGuildRankingScreenshot(screenshot.data, screenshotterId);
        
        return {
          index,
          filename: screenshot.filename,
          success: true,
          players: playerResults,
          error: null
        };
      } catch (error) {
        console.error(`❌ Erreur screenshot ${index + 1}:`, error);
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
