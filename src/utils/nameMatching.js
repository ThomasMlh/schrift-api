import { distance } from 'fastest-levenshtein';

export const getUserDisplayName = (user, fallback = 'Inconnu') =>
  user?.bbs_name || user?.global_name || user?.username || fallback;

/**
 * Normalise un nom pour la comparaison
 * Enlève les caractères spéciaux, accents, espaces
 */
export const normalizeName = (name) => {
  if (!name) return '';
  
  return name
    .toLowerCase()
    .replace(/[†|_\s-]/g, '') // Enlever †, |, _, espaces, tirets
    .replace(/[ôöò]/g, 'o')
    .replace(/[éèê]/g, 'e')
    .replace(/[àâä]/g, 'a')
    .replace(/[îï]/g, 'i')
    .replace(/[ùûü]/g, 'u')
    .replace(/[ç]/g, 'c')
    .replace(/[ñ]/g, 'n')
    .trim();
}

/**
 * Calcule la similarité entre deux chaînes (0 à 1)
 * Utilise la distance de Levenshtein normalisée
 */
export const calculateSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;
  
  const maxLength = Math.max(str1.length, str2.length);
  if (maxLength === 0) return 1.0;
  
  const dist = distance(str1, str2);
  return 1 - (dist / maxLength);
}

/**
 * Trouve le meilleur match pour un nom détecté parmi une liste d'utilisateurs
 * @param {string} detectedName - Nom détecté par OCR
 * @param {Array} guildMembers - Liste des membres de la guilde avec bbs_name
 * @returns {Object} Résultat du matching avec user, confidence, alternatives
 */
export const findBestMatch = (detectedName, guildMembers) => {
  if (!detectedName || !guildMembers || guildMembers.length === 0) {
    return {
      user: null,
      confidence: 0,
      alternatives: []
    };
  }
  
  const normalizedDetected = normalizeName(detectedName);
  
  // 1. Tentative de match exact (case insensitive)
  const exactMatch = guildMembers.find(
    m => m.bbs_name && m.bbs_name.toLowerCase() === detectedName.toLowerCase()
  );
  
  if (exactMatch) {
    return {
      user: exactMatch,
      confidence: 1.0,
      alternatives: []
    };
  }
  
  // 2. Match après normalisation complète
  const normalizedMatch = guildMembers.find(
    m => m.bbs_name && normalizeName(m.bbs_name) === normalizedDetected
  );
  
  if (normalizedMatch) {
    return {
      user: normalizedMatch,
      confidence: 0.95,
      alternatives: []
    };
  }
  
  // 3. Fuzzy matching avec Levenshtein
  const matches = guildMembers
    .filter(m => m.bbs_name) // Uniquement ceux qui ont un bbs_name
    .map(member => {
      const normalizedBbsName = normalizeName(member.bbs_name);
      const similarity = calculateSimilarity(normalizedDetected, normalizedBbsName);
      
      return {
        user: member,
        confidence: similarity
      };
    })
    .sort((a, b) => b.confidence - a.confidence);
  
  if (matches.length === 0) {
    return {
      user: null,
      confidence: 0,
      alternatives: []
    };
  }
  
  const bestMatch = matches[0];
  
  // Retourner le meilleur uniquement si confidence > 70%
  return {
    user: bestMatch.confidence > 0.70 ? bestMatch.user : null,
    confidence: bestMatch.confidence,
    alternatives: matches.slice(1, 4).filter(m => m.confidence > 0.50) // Top 3 alternatives avec confidence > 50%
  };
}

/**
 * Nettoie le texte OCR pour extraction du nom de joueur
 * Enlève les artifacts communs de l'OCR
 */
export const cleanPlayerNameOCR = (ocrText) => {
  if (!ocrText) return '';
  
  return ocrText
    .replace(/Gradus.*$/i, '') // Enlever "Gradus 1191" etc.
    .replace(/Grade.*$/i, '')  // Anglais
    .replace(/[|]/g, '')       // Barres verticales (artifacts)
    .replace(/\s{2,}/g, ' ')   // Espaces multiples
    .trim();
}

/**
 * Parse un score depuis le texte OCR
 * Format attendu : "588,187,015" ou "588187015"
 */
export const parseScore = (scoreText) => {
  if (!scoreText) {
    return { value: null, error: 'Texte vide' };
  }
  
  // Enlever tout sauf les chiffres
  const digitsOnly = scoreText.replace(/[^0-9]/g, '');
  
  // Validation : scores BBS typiques (6 à 11 chiffres pour être plus flexible)
  // Les scores vont généralement de 100,000 à 99,999,999,999
  if (digitsOnly.length < 6 || digitsOnly.length > 11) {
    return { 
      value: null, 
      error: `Format invalide (${digitsOnly.length} chiffres)` 
    };
  }
  
  const parsedValue = parseInt(digitsOnly, 10);
  
  if (isNaN(parsedValue)) {
    return { value: null, error: 'Conversion en nombre impossible' };
  }
  
  // Vérifier que le score est dans une plage raisonnable
  if (parsedValue < 100000 || parsedValue > 99999999999) {
    return { 
      value: null, 
      error: `Valeur hors limites (${parsedValue})` 
    };
  }
  
  return { value: parsedValue, error: null };
}
