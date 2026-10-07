// Découpé depuis un unique podiumService.js de 850 lignes en modules par
// fonction exportée (podium.js: getPodium/getPodiumFull, weekly.js, misses.js,
// draft.js) + helpers.js pour les fonctions pures/DB partagées. Ce fichier
// réexporte tout pour que les imports existants
// (import { getPodium, ... } from '.../podiumService.js') n'aient qu'à changer
// '.js' en '/index.js'.
export { getPodium, getPodiumFull } from './podium.js';
export { getPodiumWeekly } from './weekly.js';
export { getPodiumMisses } from './misses.js';
export { getDraftProposal, getDraftReplacement } from './draft.js';

// Helpers déjà couverts par tests/podiumService/podiumService.test.js :
// réexportés pour que ces tests n'aient qu'à changer leur chemin d'import.
export {
  getMinScoresForRanking, getCurrentGuildBbsIds, getUnguildedBbsIds,
  buildGuildMatch, overrideGuildName, applyRanks, paginate,
  isCycleInProgress, getGuildScoreMatch, getGuildBbsIdsForCycle
} from './helpers.js';
