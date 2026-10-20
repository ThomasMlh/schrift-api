import express from 'express';
import { requireDb } from '../../middleware/auth.js';
import crudRouter from './crud.js';
import rolesRouter from './roles.js';
import accountsRouter from './accounts.js';
import moderationRouter from './moderation.js';
import recordsRouter from './records.js';
import followingRouter from './following.js';

// User routes split by theme, mounted without a prefix. crud.js declares GET /without-guild and
// GET /accounts before GET /:userId in the same file, so there is no ordering constraint between
// modules (unlike guildes/index.js).
const router = express.Router();

router.use(requireDb);

router.use(crudRouter);
router.use(rolesRouter);
router.use(accountsRouter);
router.use(moderationRouter);
router.use(recordsRouter);
router.use(followingRouter);

export default router;
