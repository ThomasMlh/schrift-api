import { distance } from 'fastest-levenshtein';

export const getUserDisplayName = (user, fallback = 'Inconnu') =>
  user?.bbs_name || user?.global_name || user?.username || fallback;

/**
 * Normalizes a name for comparison (removes special characters, accents and spaces)
 */
export const normalizeName = (name) => {
  if (!name) return '';
  
  return name
    .toLowerCase()
    .replace(/[†|_\s-]/g, '') // Remove †, |, _, spaces and dashes
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
 * Similarity between two strings (0 to 1), based on the normalized Levenshtein distance
 */
export const calculateSimilarity = (str1, str2) => {
  if (!str1 || !str2) return 0;
  
  const maxLength = Math.max(str1.length, str2.length);
  if (maxLength === 0) return 1.0;
  
  const dist = distance(str1, str2);
  return 1 - (dist / maxLength);
}

/**
 * Best match for an OCR-detected name among guild members
 * @param {string} detectedName - Name detected by OCR
 * @param {Array} guildMembers - Guild members with bbs_name
 * @returns {Object} Match result with user, confidence and alternatives
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
  
  // 1. Exact match (case-insensitive)
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
  
  // 2. Match after full normalization
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
  
  // 3. Fuzzy matching with Levenshtein
  const matches = guildMembers
    .filter(m => m.bbs_name) // Only members with a bbs_name
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
  
  // Only return the best match when confidence > 70%
  return {
    user: bestMatch.confidence > 0.70 ? bestMatch.user : null,
    confidence: bestMatch.confidence,
    alternatives: matches.slice(1, 4).filter(m => m.confidence > 0.50) // Top 3 alternatives with confidence > 50%
  };
}

/**
 * Cleans OCR text to extract a player name (removes common OCR artifacts)
 */
export const cleanPlayerNameOCR = (ocrText) => {
  if (!ocrText) return '';
  
  return ocrText
    .replace(/Gradus.*$/i, '') // Remove "Gradus 1191" etc.
    .replace(/Grade.*$/i, '')  // English
    .replace(/[|]/g, '')       // Vertical bars (artifacts)
    .replace(/\s{2,}/g, ' ')   // Multiple spaces
    .trim();
}

/**
 * Parses a score from OCR text
 * Expected format: "588,187,015" or "588187015"
 */
export const parseScore = (scoreText) => {
  if (!scoreText) {
    return { value: null, error: 'Texte vide' };
  }
  
  const digitsOnly = scoreText.replace(/[^0-9]/g, '');
  
  // Typical BBS scores: 6 to 11 digits (100,000 to 99,999,999,999)
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
  
  // The score must be within a plausible range
  if (parsedValue < 100000 || parsedValue > 99999999999) {
    return { 
      value: null, 
      error: `Valeur hors limites (${parsedValue})` 
    };
  }
  
  return { value: parsedValue, error: null };
}
