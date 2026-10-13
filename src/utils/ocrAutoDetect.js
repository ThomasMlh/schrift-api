import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { cleanPlayerNameOCR, parseScore } from './nameMatching.js';
import { logger } from './logger.js';

// Debug folder for the crops (created on demand)
const DEBUG_DIR = path.join(process.cwd(), 'debug_ocr');


const base64ToBuffer = (base64String) => {
  const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}


/**
 * Preprocessing for pass 1 (score detection)
 * Reads "Score personnel hebdomadaire : XXX,XXX,XXX": greyscale + normalize + sharpen is enough
 */
const preprocessForScores = async (imageBuffer) => {
  const meta = await sharp(imageBuffer).metadata();
  const targetHeight = Math.max(meta.height, 1400);

  return sharp(imageBuffer)
    .resize(null, targetHeight, { withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
    .greyscale()
    .normalize()
    .sharpen({ sigma: 1.0 })
    .png()
    .toBuffer();
}

/**
 * Preprocessing for pass 2 (player names)
 *
 * Names are WHITE / LIGHT text (~250/255) on a dark blue background with visual noise (portraits,
 * diamonds, colored bars).
 *
 * Steps:
 *   1. Greyscale
 *   2. HIGH threshold (180): only white text survives, everything else turns black
 *   3. Negate: BLACK text on a WHITE background, ideal for Tesseract
 *   4. Resize so the text has a good size
 */
const preprocessForName = async (cropBuffer) => {
  return sharp(cropBuffer)
    .greyscale()
    .threshold(200)    // Very strict: only pure white text (~240-255) survives
    .negate()          // Black text on a white background
    .resize(null, 200, { withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
    .sharpen({ sigma: 1.0 })
    .png()
    .toBuffer();
}

/**
 * Saves a PNG buffer in the debug folder for inspection.
 */
const saveDebug = async (name, buffer) => {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const filePath = path.join(DEBUG_DIR, `${name}.png`);
    await fs.promises.writeFile(filePath, buffer);
    logger.info(`  💾 Debug image : ${filePath}`);
  } catch (e) {
    logger.warn(`  ⚠️  Impossible de sauvegarder debug : ${e.message}`);
  }
}

// Interface words to filter out

const IGNORED_WORDS = new Set([
  'place', 'score', 'personnel', 'hebdomadaire', 'groupe', 'dans', 'ligue',
  'general', 'général', 'sous', 'chef', 'grade', 'gradus', 'grader',
  'classement', 'groupes', 'retour', 'navigation', 'membre', 'navigatio',
  'le', 'de', 'du', 'des', 'la', 'les', 'en', 'au', 'aux',
  'ere', 'eme', 're', 'personnelle', 'personnels',
]);


/**
 * Automatically detects scores and player names in a BBS screenshot.
 *
 * Two passes:
 *   Pass 1 - global OCR (eng) to locate the "Score personnel hebdomadaire : XXX" lines and get their
 *            bounding boxes.
 *   Pass 2 - for each score, crop the name area (just above the score, in the right half of the
 *            image), apply an inverted preprocessing and run a small dedicated OCR (eng+jpn).
 *
 * This fixes names misread on the full image (portraits, diamonds and badges polluting the global OCR).
 */
export const processGuildRankingScreenshotAuto = async (base64Image) => {
  try {
    logger.info('🔍 Début du traitement OCR automatique (2 passes)...');

    const imageBuffer = base64ToBuffer(base64Image);
    const originalMeta = await sharp(imageBuffer).metadata();
    const { width: origW, height: origH } = originalMeta;
    logger.info(`📐 Image originale : ${origW}×${origH}`);

    // Pass 1: locate the scores

    const processedBuffer = await preprocessForScores(imageBuffer);
    const processedMeta = await sharp(processedBuffer).metadata();

    // Scale ratio from processed to original coordinates
    const scaleX = origW / processedMeta.width;
    const scaleY = origH / processedMeta.height;

    logger.info('🔎 Pass 1 : Détection des scores (OCR global eng)...');
    const { data } = await Tesseract.recognize(processedBuffer, 'eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          logger.info(`  OCR global : ${Math.round(m.progress * 100)}%`);
        }
      },
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
      tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
    });

    logger.info('📄 Texte brut pass 1 :\n' + (data.text || '(vide)') + '\n---');

    // Score lines with their bounding boxes
    const scoreEntries = findScoreLines(data);

    if (scoreEntries.length === 0) {
      logger.info('⚠️  Aucun score trouvé via data.lines. Fallback texte brut...');
      return fallbackParseText(data.text).slice(0, 5);
    }

    logger.info(`  → ${scoreEntries.length} scores localisés\n`);

    // Pass 2: crop and OCR each player name

    logger.info('🔎 Pass 2 : Détection des pseudos (crops individuels)...');

    const players = [];

    for (const entry of scoreEntries) {
      const { score, bboxProcessed } = entry;

      // Bounding box from the processed image to the original image
      const bboxOrig = {
        x0: Math.round(bboxProcessed.x0 * scaleX),
        y0: Math.round(bboxProcessed.y0 * scaleY),
        x1: Math.round(bboxProcessed.x1 * scaleX),
        y1: Math.round(bboxProcessed.y1 * scaleY),
      };

      // Height of the "Score personnel hebdomadaire" line in the original image
      const scoreLineH = bboxOrig.y1 - bboxOrig.y0;

      // Name area: above the score, right part of the image.
      // The name is on ONE line, about 1.5-2.5× the height of the score text
      const nameH = Math.round(scoreLineH * 2.5);
      const crop = {
        left:   Math.round(origW * 0.33),        // After the portrait (~33%)
        top:    Math.max(0, bboxOrig.y0 - nameH), // Just above the score
        width:  Math.round(origW * 0.35),          // Name area (not too wide)
        height: Math.min(nameH, bboxOrig.y0),      // Up to the score
      };

      // Safety bounds
      crop.left   = Math.min(crop.left, origW - 10);
      crop.width  = Math.min(crop.width, origW - crop.left);
      crop.top    = Math.max(0, crop.top);
      crop.height = Math.min(crop.height, origH - crop.top);

      if (crop.width < 20 || crop.height < 10) {
        logger.info(`  ⚠️  Crop trop petit pour score ${score.toLocaleString('fr-FR')}`);
        players.push(makePlayer(players.length + 1, '', score, 50));
        continue;
      }

      logger.info(`  🖼️  Score ${score.toLocaleString('fr-FR')} → crop name : left=${crop.left} top=${crop.top} w=${crop.width} h=${crop.height}`);

      try {
        // Crop from the ORIGINAL image (better quality)
        const nameCropRaw = await sharp(imageBuffer).extract(crop).png().toBuffer();

        // Inverted preprocessing (negate) for names
        const nameCropProcessed = await preprocessForName(nameCropRaw);

        // Save the crops for debugging
        await saveDebug(`score${players.length + 1}_raw`, nameCropRaw);
        await saveDebug(`score${players.length + 1}_processed`, nameCropProcessed);

        // Name OCR (eng+jpn to support Japanese names).
        // PSM.SINGLE_LINE (7): a single line of text is expected (the name)
        const { data: nameData } = await Tesseract.recognize(nameCropProcessed, 'eng+jpn', {
          tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
          tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
        });

        const rawNameText = (nameData.text || '').trim();
        logger.info(`  📝 OCR pseudo brut : "${rawNameText}"`);

        const name = extractPlayerName(rawNameText);
        const cleanedName = name ? cleanPlayerNameOCR(name) : '';

        logger.info(`  ✅ Joueur ${players.length + 1} : "${cleanedName || '???'}" → ${score.toLocaleString('fr-FR')}`);

        players.push(makePlayer(players.length + 1, cleanedName, score, cleanedName ? 85 : 50));
      } catch (err) {
        logger.error(`  ❌ Erreur crop pseudo :`, err.message);
        players.push(makePlayer(players.length + 1, '', score, 50));
      }
    }

    // At most 5 players per screenshot
    const result = players.slice(0, 5);

    logger.info(`\n🎯 Résultat final : ${result.length} joueurs`);
    result.forEach((p, i) =>
      logger.info(`  ${i + 1}. "${p.detectedName}" → ${p.score.toLocaleString('fr-FR')}`)
    );

    return result;
  } catch (error) {
    logger.error('❌ Erreur OCR auto :', error);
    throw error;
  }
}


/**
 * Finds the "Score personnel hebdomadaire : XXX" lines in data.lines
 * Returns an array of { score, bboxProcessed }
 */
const findScoreLines = (data) => {
  const results = [];

  // Flexible pattern, tolerant to approximate OCR
  const scoreRegex =
    /[Ss]c[o0]re\s*(?:personnel|personnet|personne[l!i])\s*(?:hebdomadaire|hebdomadalre|hebdomadatre|hebdomataire)\s*[:;]?\s*([\d][,.\d\s]*[\d])/;

  const lines = data.lines || [];
  logger.info(`  findScoreLines : ${lines.length} lignes trouvées par Tesseract`);

  for (const line of lines) {
    if (!line.text || !line.bbox) continue;

    const m = line.text.match(scoreRegex);
    if (!m) continue;

    const rawScore = m[1].replace(/[\s.]/g, '');
    const scoreResult = parseScore(rawScore);

    if (scoreResult?.value > 0) {
      logger.info(`  ✓ Score trouvé : ${scoreResult.value.toLocaleString('fr-FR')} (bbox y0=${line.bbox.y0})`);
      results.push({
        score: scoreResult.value,
        bboxProcessed: line.bbox,
      });
    }
  }

  // When data.lines missed some, try data.words
  if (results.length < 5 && data.words && data.words.length > 0) {
    logger.info(`  ⚠️  Seulement ${results.length} scores via lines, tentative via words...`);
    const existingScores = new Set(results.map(r => r.score));

    // Rebuild the line text from consecutive words and look for the pattern
    const words = data.words;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w.text || !w.bbox) continue;

      // A word starting with "Score" or "score"
      if (!/^[Ss]c[o0]re$/i.test(w.text.trim())) continue;

      // Join the following words (up to 8) to form the full line
      let lineText = w.text;
      let lastBbox = w.bbox;
      for (let j = i + 1; j < Math.min(words.length, i + 8); j++) {
        if (!words[j].text) break;
        // The next word must be on the same line (similar Y)
        if (Math.abs(words[j].bbox.y0 - w.bbox.y0) > (w.bbox.y1 - w.bbox.y0) * 1.5) break;
        lineText += ' ' + words[j].text;
        lastBbox = words[j].bbox;
      }

      const m = lineText.match(scoreRegex);
      if (!m) continue;

      const rawScore = m[1].replace(/[\s.]/g, '');
      const scoreResult = parseScore(rawScore);

      if (scoreResult?.value > 0 && !existingScores.has(scoreResult.value)) {
        logger.info(`  ✓ Score trouvé via words : ${scoreResult.value.toLocaleString('fr-FR')} (bbox y0=${w.bbox.y0})`);
        // Bounding box covering the whole line (first to last word)
        results.push({
          score: scoreResult.value,
          bboxProcessed: {
            x0: w.bbox.x0,
            y0: w.bbox.y0,
            x1: lastBbox.x1,
            y1: Math.max(w.bbox.y1, lastBbox.y1),
          },
        });
        existingScores.add(scoreResult.value);
      }
    }
  }

  // Sort by Y (top to bottom of the image)
  results.sort((a, b) => a.bboxProcessed.y0 - b.bboxProcessed.y0);

  logger.info(`  → Total : ${results.length} scores trouvés`);
  return results;
}


/**
 * Extracts a player name from the OCR text of a name crop.
 *
 * The crop may contain:
 *   - the name (what we want)
 *   - "Sous-chef", "Chef" (guild role)
 *   - "Grade 1134" (grade badge)
 *   - OCR artifacts (diamonds ◇, symbols…)
 *
 * Everything but the name is filtered out.
 */
const extractPlayerName = (text) => {
  if (!text) return null;

  // Clean the raw text
  let cleaned = text
    .replace(/\n/g, ' ')                          // Single line
    .replace(/[Gg]rade[r]?\s*[\d]+/g, '')          // Remove "Grade 1134"
    .replace(/[◇◆♦♢◈⬥⬦○●□■△▲☆★]+/g, '')         // Remove diamond symbols
    .replace(/\b\d+[eèère]+\s*place\b/gi, '')      // Remove "11e place"
    .replace(/\b[0O]{3,}\b/g, '')                  // Remove "0000" / "OOOO" (misread diamonds)
    .trim();

  // Split into tokens (full Unicode: Latin, Japanese, …)
  const tokens = cleaned.match(/[\p{L}\p{N}_'†-]+/gu) || [];

  if (tokens.length === 0) return null;

  // Drop non-name tokens
  const candidates = tokens.filter(token => {
    const lower = token.toLowerCase();
    if (IGNORED_WORDS.has(lower)) return false;
    if (/^\d+$/.test(token)) return false;                      // Pure numbers
    if (/^\d+[reè]+$/i.test(token)) return false;              // "1re", "2e"…
    if (token.length <= 2 && /^[a-zA-Z]+$/.test(token)) return false; // 2-character Latin noise
    return true;
  });

  if (candidates.length === 0) return null;

  logger.info(`    candidats pseudo : [${candidates.join(', ')}]`);

  // Heuristic: the name is the best candidate
  //   1. Mixed case first (AeRo, MrMousse…), typical of player names
  //   2. Then tokens with non-ASCII characters (十香, 零Shiro…)
  //   3. Otherwise the longest
  candidates.sort((a, b) => {
    const aMixed = /[a-z]/.test(a) && /[A-Z]/.test(a) ? 2 : 0;
    const bMixed = /[a-z]/.test(b) && /[A-Z]/.test(b) ? 2 : 0;

    // eslint-disable-next-line no-control-regex
    const aNonAscii = /[^\x00-\x7F]/.test(a) ? 1 : 0;
    // eslint-disable-next-line no-control-regex
    const bNonAscii = /[^\x00-\x7F]/.test(b) ? 1 : 0;

    const aScore = aMixed + aNonAscii + a.length * 0.1;
    const bScore = bMixed + bNonAscii + b.length * 0.1;

    return bScore - aScore;
  });

  return candidates[0];
}


/**
 * Fallback when data.lines has no bounding boxes.
 * Parses the raw text to find the score lines and the names above them.
 */
const fallbackParseText = (text) => {
  if (!text) return [];

  const players = [];
  const lines = text.split('\n').map(l => l.trim());
  const usedLines = new Set();

  const scoreRegex =
    /[Ss]c[o0]re\s*(?:personnel|personnet|personne[l!i])\s*(?:hebdomadaire|hebdomadalre|hebdomadatre)\s*[:;]?\s*([\d][,.\d\s]*[\d])/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(scoreRegex);
    if (!m) continue;

    const rawScore = m[1].replace(/[\s.]/g, '');
    const scoreResult = parseScore(rawScore);
    if (!scoreResult?.value) continue;

    // Look for the name in the 1-3 previous lines
    let name = null;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (usedLines.has(j) || !lines[j]) continue;
      name = extractPlayerName(lines[j]);
      if (name) { usedLines.add(j); break; }
    }

    const cleanedName = name ? cleanPlayerNameOCR(name) : '';
    players.push(makePlayer(players.length + 1, cleanedName, scoreResult.value, cleanedName ? 70 : 50));
  }

  return players;
}


const makePlayer = (lineNumber, name, score, confidence) => {
  return {
    lineNumber,
    detectedName: name,
    score,
    confidence,
    hasValidName: name.length > 0,
    hasValidScore: true,
    bbox: {
      name: { x0: 0, y0: 0, x1: 0, y1: 0 },
      score: { x0: 0, y0: 0, x1: 0, y1: 0 },
    },
  };
}


/**
 * Processes several screenshots (sequentially to limit memory usage).
 */
export const processBatchScreenshotsAuto = async (screenshots) => {
  logger.info(`\n🎯 Traitement batch de ${screenshots.length} screenshots (mode auto, 2 passes)`);

  const results = [];

  for (let index = 0; index < screenshots.length; index++) {
    const screenshot = screenshots[index];
    try {
      logger.info(`\n📸 Screenshot ${index + 1}/${screenshots.length} : ${screenshot.filename}`);
      const players = await processGuildRankingScreenshotAuto(screenshot.data);
      results.push({ index, filename: screenshot.filename, success: true, players });
    } catch (error) {
      logger.error(`❌ Erreur screenshot ${index + 1} :`, error);
      results.push({ index, filename: screenshot.filename, success: false, error: error.message, players: [] });
    }
  }

  const ok = results.filter(r => r.success).length;
  logger.info(`\n✅ ${ok}/${screenshots.length} screenshots traités avec succès`);
  return results;
}
