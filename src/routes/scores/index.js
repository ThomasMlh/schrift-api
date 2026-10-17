import express from 'express';
import { requireDb } from '../../middleware/auth.js';
import crudRouter from './crud.js';
import bulkRouter from './bulk.js';
import transfersRouter from './transfers.js';
import alertsRouter from './alerts.js';

// Score routes split by theme (crud, bulk entry, transfers, monitoring tools), mounted without a prefix.
const router = express.Router();

router.use(requireDb);

// Mounted before crud so the leader tool routes (/decline-alerts, /anomalies, /history, /missing,
// /preparation, /bulk-context) are not caught by GET /:id
router.use(alertsRouter);
router.use(crudRouter);
router.use(bulkRouter);
router.use(transfersRouter);

export default router;
