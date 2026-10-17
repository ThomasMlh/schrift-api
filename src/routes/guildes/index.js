import express from 'express';
import { requireDb } from '../../middleware/auth.js';
import statsRouter from './stats.js';
import crudRouter from './crud.js';
import membersRouter from './members.js';
import draftRouter from './draft.js';
import goalsRouter from './goals.js';

// Guild routes, split by theme and mounted without a prefix.
//
// ORDER MATTERS: statsRouter must be mounted before crudRouter. stats.js exposes GET /rankings and
// GET /members-summary while crud.js exposes GET /:id; Express matches routes in mounting order, so
// /:id would otherwise catch /rankings with id="rankings".
const router = express.Router();

router.use(requireDb);

router.use(statsRouter);
router.use(crudRouter);
router.use(membersRouter);
router.use(draftRouter);
router.use(goalsRouter);

export default router;
