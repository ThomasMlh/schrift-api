// Logger minimal, sans dépendance : centralise tous les logs de l'API
// derrière une seule interface (info/warn/error/debug) horodatée.
//
// Objectif : pouvoir un jour rediriger/filtrer les logs (fichier, service
// externe, niveau par environnement) en un seul endroit, sans repasser sur
// chaque route. Pour l'instant il écrit toujours sur console, avec un
// horodatage, sauf logger.debug qui est coupé en production.
const isProd = process.env.NODE_ENV === 'production';

const timestamp = () => new Date().toISOString();

export const logger = {
  info: (...args) => console.log(`[${timestamp()}]`, ...args),
  warn: (...args) => console.warn(`[${timestamp()}]`, ...args),
  error: (...args) => console.error(`[${timestamp()}]`, ...args),
  // Traces de diagnostic (détail des étapes OCR, payloads, etc.) : utiles en
  // dev, superflues (voire bruyantes) en prod.
  debug: (...args) => {
    if (!isProd) console.log(`[${timestamp()}] [DEBUG]`, ...args);
  },
};
