// Unescapes a string (\n, \", \\, \t, \r) and trims it
export const cleanString = (str) => {
  if (typeof str !== 'string') return str;
  
  return str
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .trim();
}

// Recursively cleans every string of an object
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