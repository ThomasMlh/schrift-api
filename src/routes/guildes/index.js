import express from 'express';
import { requireDb } from '../../middleware/auth.js';
import statsRouter from './stats.js';
import crudRouter from './crud.js';
import membersRouter from './members.js';
import draftRouter from './draft.js';
import goalsRouter from './goals.js';

// Découpé depuis un unique guildes.js de 991 lignes (19 routes) en 4 modules
// par thème. Montage sans préfixe : les chemins exposés sous /api/guildes
// sont identiques à avant la découpe.
//
// ORDRE IMPORTANT : statsRouter doit être monté avant crudRouter. stats.js
// expose GET /rankings et GET /members-summary ; crud.js expose GET /:id.
// Express matche les routes dans l'ordre de montage, donc si /:id passait
// avant, une requête vers /rankings serait interceptée par /:id avec
// id="rankings" au lieu d'atteindre le vrai handler (c'était déjà l'ordre
// du fichier original : rankings/members-summary étaient déclarées avant
// GET /:id).
const router = express.Router();

router.use(requireDb);

router.use(statsRouter);
router.use(crudRouter);
router.use(membersRouter);
router.use(draftRouter);
router.use(goalsRouter);

export default router;
