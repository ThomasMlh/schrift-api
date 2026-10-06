import express from 'express';
import { requireDb } from '../../middleware/auth.js';
import crudRouter from './crud.js';
import bulkRouter from './bulk.js';
import transfersRouter from './transfers.js';
import alertsRouter from './alerts.js';

// Découpé depuis un unique scores.js de 1429 lignes en 3 modules par thème :
// crud (lecture/écriture simple), bulk (saisie groupée), transfers (transfert
// de rotation / de compte). Tous montés sans préfixe : les chemins exposés
// sous /api/scores sont rigoureusement identiques à avant la découpe.
const router = express.Router();

router.use(requireDb);

// Monté avant crud pour que les routes des outils chefs (/decline-alerts, /anomalies, /history,
// /missing, /preparation) ne soient pas capturées par GET /:id
router.use(alertsRouter);
router.use(crudRouter);
router.use(bulkRouter);
router.use(transfersRouter);

export default router;
