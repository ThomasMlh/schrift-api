import express from 'express';
import { requireDb } from '../../middleware/auth.js';
import crudRouter from './crud.js';
import rolesRouter from './roles.js';
import accountsRouter from './accounts.js';
import moderationRouter from './moderation.js';
import recordsRouter from './records.js';

// Découpé depuis un unique users.js de 930 lignes (17 routes) en 4 modules
// par thème. Montage sans préfixe : les chemins exposés sous /api/users sont
// identiques à avant la découpe. crud.js garde GET /without-guild et
// GET /accounts avant GET /:userId dans le MÊME fichier (ordre interne
// préservé), donc aucune contrainte d'ordre entre modules ici contrairement
// à guildes/index.js.
const router = express.Router();

router.use(requireDb);

router.use(crudRouter);
router.use(rolesRouter);
router.use(accountsRouter);
router.use(moderationRouter);
router.use(recordsRouter);

export default router;
