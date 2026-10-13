import express from 'express';
import { requireDb } from '../../middleware/auth.js';
import createRouter from './create.js';
import crudRouter from './crud.js';
import updateRouter from './update.js';
import screenshotRouter from './screenshot.js';

// Builds routes by lifecycle step: create.js (POST /), crud.js (GET /, GET /:id, DELETE /:id),
// update.js (PATCH /:id, PATCH /:id/validate), screenshot.js; enrich.js holds the shared enrichment
// helpers. Mounted without a prefix, with no ordering constraint between modules.
const router = express.Router();

router.use(requireDb);

router.use(createRouter);
router.use(crudRouter);
router.use(updateRouter);
router.use(screenshotRouter);

export default router;
