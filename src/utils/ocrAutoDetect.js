import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { cleanPlayerNameOCR, parseScore } from './nameMatching.js';

// Dossier debug pour sauvegarder les crops (créé à la volée)
const DEBUG_DIR = path.join(process.cwd(), 'debug_ocr');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const base64ToBuffer = (base64String) => {
  const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(base64Data, 'base64');
}

// ─── Preprocessing ────────────────────────────────────────────────────────────

/**
 * Preprocessing pour le pass 1 (détection des scores)
 * On veut lire « Score personnel hebdomadaire : XXX,XXX,XXX »
 * → greyscale + normalize + sharpen suffit
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
 * Preprocessing pour le pass 2 (lecture des pseudos)
 *
 * Les pseudos sont en texte BLANC / CLAIR (~250/255) sur fond bleu foncé
 * avec du bruit visuel (portraits, diamants, barres colorées).
 *
 * Stratégie : 
 *   1. Greyscale
 *   2. Threshold HAUT (180) → seul le texte blanc survit, tout le reste = noir
 *   3. Negate → texte NOIR sur fond BLANC = parfait pour Tesseract
 *   4. Resize pour que le texte fasse une bonne taille
 */
const preprocessForName = async (cropBuffer) => {
  return sharp(cropBuffer)
    .greyscale()
    .threshold(200)    // Très strict : seul le texte blanc pur (~240-255) survit
    .negate()          // Blanc→noir, noir→blanc → texte noir sur fond blanc
    .resize(null, 200, { withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
    .sharpen({ sigma: 1.0 })
    .png()
    .toBuffer();
}

/**
 * Sauvegarde un buffer PNG dans le dossier debug pour inspection.
 */
const saveDebug = async (name, buffer) => {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const filePath = path.join(DEBUG_DIR, `${name}.png`);
    await fs.promises.writeFile(filePath, buffer);
    console.log(`  💾 Debug image : ${filePath}`);
  } catch (e) {
    console.warn(`  ⚠️  Impossible de sauvegarder debug : ${e.message}`);
  }
}

// ─── Mots de l'interface à filtrer ────────────────────────────────────────────

const IGNORED_WORDS = new Set([
  'place', 'score', 'personnel', 'hebdomadaire', 'groupe', 'dans', 'ligue',
  'general', 'général', 'sous', 'chef', 'grade', 'gradus', 'grader',
  'classement', 'groupes', 'retour', 'navigation', 'membre', 'navigatio',
  'le', 'de', 'du', 'des', 'la', 'les', 'en', 'au', 'aux',
  'ere', 'eme', 're', 'personnelle', 'personnels',
]);

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Détecte automatiquement les scores et pseudos dans un screenshot BBS.
 *
 * Stratégie en 2 passes :
 *   Pass 1 — OCR global (eng) pour localiser les lignes « Score personnel
 *            hebdomadaire : XXX » et récupérer leurs bounding boxes.
 *   Pass 2 — Pour chaque score trouvé, on recadre la zone du pseudo (juste
 *            au-dessus du score, dans la moitié droite de l'image), on applique
 *            un preprocessing inversé, et on fait un petit OCR (eng+jpn) dédié.
 *
 * Cette approche résout le problème des pseudos mal lus sur l'image complète
 * (portraits, diamants, badges qui polluent l'OCR global).
 */
export const processGuildRankingScreenshotAuto = async (base64Image) => {
  try {
    console.log('🔍 Début du traitement OCR automatique (2 passes)...');

    const imageBuffer = base64ToBuffer(base64Image);
    const originalMeta = await sharp(imageBuffer).metadata();
    const { width: origW, height: origH } = originalMeta;
    console.log(`📐 Image originale : ${origW}×${origH}`);

    // ── Pass 1 : Localiser les scores ─────────────────────────────────────

    const processedBuffer = await preprocessForScores(imageBuffer);
    const processedMeta = await sharp(processedBuffer).metadata();

    // Rapport d'échelle pour convertir les coordonnées processées → originales
    const scaleX = origW / processedMeta.width;
    const scaleY = origH / processedMeta.height;

    console.log('🔎 Pass 1 : Détection des scores (OCR global eng)...');
    const { data } = await Tesseract.recognize(processedBuffer, 'eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          console.log(`  OCR global : ${Math.round(m.progress * 100)}%`);
        }
      },
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
      tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
    });

    console.log('📄 Texte brut pass 1 :\n' + (data.text || '(vide)') + '\n---');

    // Extraire les lignes de score avec leurs bounding boxes
    const scoreEntries = findScoreLines(data);

    if (scoreEntries.length === 0) {
      console.log('⚠️  Aucun score trouvé via data.lines. Fallback texte brut...');
      return fallbackParseText(data.text).slice(0, 5);
    }

    console.log(`  → ${scoreEntries.length} scores localisés\n`);

    // ── Pass 2 : Recadrer et OCR chaque pseudo ───────────────────────────

    console.log('🔎 Pass 2 : Détection des pseudos (crops individuels)...');

    const players = [];

    for (const entry of scoreEntries) {
      const { score, bboxProcessed } = entry;

      // Convertir bbox du repère preprocessé vers l'image originale
      const bboxOrig = {
        x0: Math.round(bboxProcessed.x0 * scaleX),
        y0: Math.round(bboxProcessed.y0 * scaleY),
        x1: Math.round(bboxProcessed.x1 * scaleX),
        y1: Math.round(bboxProcessed.y1 * scaleY),
      };

      // Hauteur de la ligne "Score personnel hebdomadaire" dans l'image originale
      const scoreLineH = bboxOrig.y1 - bboxOrig.y0;

      // Zone du pseudo : au-dessus du score, partie droite de l'image
      // Le pseudo est sur UNE ligne, environ 1.5-2.5× la hauteur du texte de score
      const nameH = Math.round(scoreLineH * 2.5);
      const crop = {
        left:   Math.round(origW * 0.33),        // après le portrait (~33%)
        top:    Math.max(0, bboxOrig.y0 - nameH), // juste au-dessus du score
        width:  Math.round(origW * 0.35),          // zone pseudo (pas trop large)
        height: Math.min(nameH, bboxOrig.y0),      // jusqu'au score
      };

      // Bornes de sécurité
      crop.left   = Math.min(crop.left, origW - 10);
      crop.width  = Math.min(crop.width, origW - crop.left);
      crop.top    = Math.max(0, crop.top);
      crop.height = Math.min(crop.height, origH - crop.top);

      if (crop.width < 20 || crop.height < 10) {
        console.log(`  ⚠️  Crop trop petit pour score ${score.toLocaleString('fr-FR')}`);
        players.push(makePlayer(players.length + 1, '', score, 50));
        continue;
      }

      console.log(`  🖼️  Score ${score.toLocaleString('fr-FR')} → crop name : left=${crop.left} top=${crop.top} w=${crop.width} h=${crop.height}`);

      try {
        // Recadrer depuis l'image ORIGINALE (meilleure qualité)
        const nameCropRaw = await sharp(imageBuffer).extract(crop).png().toBuffer();

        // Preprocessing inversé (negate) pour les pseudos
        const nameCropProcessed = await preprocessForName(nameCropRaw);

        // Sauvegarder les crops pour debug
        await saveDebug(`score${players.length + 1}_raw`, nameCropRaw);
        await saveDebug(`score${players.length + 1}_processed`, nameCropProcessed);

        // OCR du pseudo (eng+jpn pour supporter les noms japonais)
        // PSM.SINGLE_LINE (7) : on attend UNE seule ligne de texte (le pseudo)
        const { data: nameData } = await Tesseract.recognize(nameCropProcessed, 'eng+jpn', {
          tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
          tessedit_ocr_engine_mode: Tesseract.OEM.LSTM_ONLY,
        });

        const rawNameText = (nameData.text || '').trim();
        console.log(`  📝 OCR pseudo brut : "${rawNameText}"`);

        const name = extractPlayerName(rawNameText);
        const cleanedName = name ? cleanPlayerNameOCR(name) : '';

        console.log(`  ✅ Joueur ${players.length + 1} : "${cleanedName || '???'}" → ${score.toLocaleString('fr-FR')}`);

        players.push(makePlayer(players.length + 1, cleanedName, score, cleanedName ? 85 : 50));
      } catch (err) {
        console.error(`  ❌ Erreur crop pseudo :`, err.message);
        players.push(makePlayer(players.length + 1, '', score, 50));
      }
    }

    // Max 5 joueurs par screenshot
    const result = players.slice(0, 5);

    console.log(`\n🎯 Résultat final : ${result.length} joueurs`);
    result.forEach((p, i) =>
      console.log(`  ${i + 1}. "${p.detectedName}" → ${p.score.toLocaleString('fr-FR')}`)
    );

    return result;
  } catch (error) {
    console.error('❌ Erreur OCR auto :', error);
    throw error;
  }
}

// ─── Extraction des lignes de score ───────────────────────────────────────────

/**
 * Cherche les lignes « Score personnel hebdomadaire : XXX » dans data.lines
 * Retourne un tableau de { score, bboxProcessed }
 */
const findScoreLines = (data) => {
  const results = [];

  // Pattern flexible : tolère OCR approximatif
  const scoreRegex =
    /[Ss]c[o0]re\s*(?:personnel|personnet|personne[l!i])\s*(?:hebdomadaire|hebdomadalre|hebdomadatre|hebdomataire)\s*[:;]?\s*([\d][,.\d\s]*[\d])/;

  const lines = data.lines || [];
  console.log(`  findScoreLines : ${lines.length} lignes trouvées par Tesseract`);

  for (const line of lines) {
    if (!line.text || !line.bbox) continue;

    const m = line.text.match(scoreRegex);
    if (!m) continue;

    const rawScore = m[1].replace(/[\s.]/g, '');
    const scoreResult = parseScore(rawScore);

    if (scoreResult?.value > 0) {
      console.log(`  ✓ Score trouvé : ${scoreResult.value.toLocaleString('fr-FR')} (bbox y0=${line.bbox.y0})`);
      results.push({
        score: scoreResult.value,
        bboxProcessed: line.bbox,
      });
    }
  }

  // Si data.lines n'a pas tout trouvé, essayer via data.words
  if (results.length < 5 && data.words && data.words.length > 0) {
    console.log(`  ⚠️  Seulement ${results.length} scores via lines, tentative via words...`);
    const existingScores = new Set(results.map(r => r.score));

    // Reconstruire le texte à partir des mots consécutifs et chercher le pattern
    const words = data.words;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w.text || !w.bbox) continue;

      // Chercher un mot qui commence par "Score" ou "score"
      if (!/^[Ss]c[o0]re$/i.test(w.text.trim())) continue;

      // Concaténer les mots suivants (jusqu'à 8 mots après) pour former la ligne complète
      let lineText = w.text;
      let lastBbox = w.bbox;
      for (let j = i + 1; j < Math.min(words.length, i + 8); j++) {
        if (!words[j].text) break;
        // Vérifier que le mot suivant est sur la même ligne (Y similaire)
        if (Math.abs(words[j].bbox.y0 - w.bbox.y0) > (w.bbox.y1 - w.bbox.y0) * 1.5) break;
        lineText += ' ' + words[j].text;
        lastBbox = words[j].bbox;
      }

      const m = lineText.match(scoreRegex);
      if (!m) continue;

      const rawScore = m[1].replace(/[\s.]/g, '');
      const scoreResult = parseScore(rawScore);

      if (scoreResult?.value > 0 && !existingScores.has(scoreResult.value)) {
        console.log(`  ✓ Score trouvé via words : ${scoreResult.value.toLocaleString('fr-FR')} (bbox y0=${w.bbox.y0})`);
        // Utiliser la bbox qui couvre toute la ligne (du premier au dernier mot)
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

  // Trier par Y (du haut vers le bas de l'image)
  results.sort((a, b) => a.bboxProcessed.y0 - b.bboxProcessed.y0);

  console.log(`  → Total : ${results.length} scores trouvés`);
  return results;
}

// ─── Extraction du pseudo ─────────────────────────────────────────────────────

/**
 * Extrait le pseudo d'un joueur depuis le texte OCR d'un crop de nom.
 *
 * Le crop peut contenir :
 *   - Le pseudo (ce qu'on veut)
 *   - « Sous-chef », « Chef » (rôle guilde)
 *   - « Grade 1134 » (badge de grade)
 *   - Des artefacts OCR (diamants ◇, symboles…)
 *
 * On filtre tout sauf le pseudo.
 */
const extractPlayerName = (text) => {
  if (!text) return null;

  // Nettoyer le texte brut
  let cleaned = text
    .replace(/\n/g, ' ')                          // une seule ligne
    .replace(/[Gg]rade[r]?\s*[\d]+/g, '')          // retirer "Grade 1134"
    .replace(/[◇◆♦♢◈⬥⬦○●□■△▲☆★]+/g, '')         // retirer symboles diamants
    .replace(/\b\d+[eèère]+\s*place\b/gi, '')      // retirer "11e place"
    .replace(/\b[0O]{3,}\b/g, '')                  // retirer "0000" / "OOOO" (diamants mal lus)
    .trim();

  // Diviser en tokens (support unicode complet : latin, japonais, etc.)
  const tokens = cleaned.match(/[\p{L}\p{N}_'†-]+/gu) || [];

  if (tokens.length === 0) return null;

  // Filtrer les tokens non-pseudo
  const candidates = tokens.filter(token => {
    const lower = token.toLowerCase();
    if (IGNORED_WORDS.has(lower)) return false;
    if (/^\d+$/.test(token)) return false;                      // nombres purs
    if (/^\d+[reè]+$/i.test(token)) return false;              // "1re", "2e"…
    if (token.length <= 2 && /^[a-zA-Z]+$/.test(token)) return false; // bruit latin 2 chars
    return true;
  });

  if (candidates.length === 0) return null;

  console.log(`    candidats pseudo : [${candidates.join(', ')}]`);

  // Heuristique : le pseudo est le meilleur candidat
  //   1. Priorité à la casse mixte (AeRo, MrMousse…) → typique pseudo gamer
  //   2. Priorité aux tokens avec caractères non-ASCII (十香, 零Shiro…)
  //   3. Sinon, le plus long
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

// ─── Fallback : parsing texte brut (sans bboxes) ─────────────────────────────

/**
 * Fallback si data.lines n'a pas de bounding boxes.
 * Parse le texte brut pour trouver les lignes de score et les pseudos au-dessus.
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

    // Chercher le pseudo dans les 1-3 lignes précédentes
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

// ─── Utilitaire ───────────────────────────────────────────────────────────────

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

// ─── Traitement batch ─────────────────────────────────────────────────────────

/**
 * Traite plusieurs screenshots (séquentiellement pour éviter la surcharge mémoire).
 */
export const processBatchScreenshotsAuto = async (screenshots) => {
  console.log(`\n🎯 Traitement batch de ${screenshots.length} screenshots (mode auto, 2 passes)`);

  const results = [];

  for (let index = 0; index < screenshots.length; index++) {
    const screenshot = screenshots[index];
    try {
      console.log(`\n📸 Screenshot ${index + 1}/${screenshots.length} : ${screenshot.filename}`);
      const players = await processGuildRankingScreenshotAuto(screenshot.data);
      results.push({ index, filename: screenshot.filename, success: true, players });
    } catch (error) {
      console.error(`❌ Erreur screenshot ${index + 1} :`, error);
      results.push({ index, filename: screenshot.filename, success: false, error: error.message, players: [] });
    }
  }

  const ok = results.filter(r => r.success).length;
  console.log(`\n✅ ${ok}/${screenshots.length} screenshots traités avec succès`);
  return results;
}
