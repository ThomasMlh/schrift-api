// Fonction pour nettoyer les chaînes de caractères avec échappement
export const cleanString = (str) => {
  if (typeof str !== 'string') return str;
  
  return str
    .replace(/\\n/g, '\n')        // Remplacer \\n par de vrais retours à la ligne
    .replace(/\\"/g, '"')         // Remplacer \" par "
    .replace(/\\\\/g, '\\')       // Remplacer \\\\ par \\
    .replace(/\\t/g, '\t')        // Remplacer \\t par des tabs
    .replace(/\\r/g, '\r')        // Remplacer \\r par des retours chariot
    .trim();                      // Supprimer les espaces en début/fin
}

// Fonction récursive pour nettoyer un objet
export const cleanObject = (obj) => {
  if (typeof obj === 'string') {
    return cleanString(obj);
  } else if (Array.isArray(obj)) {
    return obj.map(cleanObject);
  } else if (obj && typeof obj === 'object') {
    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      cleaned[key] = cleanObject(value);
    }
    return cleaned;
  }
  return obj;
}