import express from 'express';
import { requireDb } from '../../middleware/auth.js';
import createRouter from './create.js';
import crudRouter from './crud.js';
import updateRouter from './update.js';
import screenshotRouter from './screenshot.js';

// Découpé depuis un unique builds.js de 944 lignes (6 routes, mais 2
// handlers de 250-280 lignes chacun) en modules par étape du cycle de vie :
// create.js (POST /), crud.js (GET /, GET /:id, DELETE /:id), update.js
// (PATCH /:id, PATCH /:id/validate). enrich.js porte les 3 helpers
// d'enrichissement (user/rotation/team) partagés par les trois. Montage
// sans préfixe : chemins identiques à avant la découpe. Pas de contrainte
// d'ordre entre modules (aucune route littérale du type /rankings ici).
const router = express.Router();

router.use(requireDb);

router.use(createRouter);
router.use(crudRouter);
router.use(updateRouter);
router.use(screenshotRouter);

export default router;
