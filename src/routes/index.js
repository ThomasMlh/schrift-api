import express from 'express';
import charactersRouter from './characters.js';
import guildesRouter from './guildes.js';
import membresRouter from './membres.js';
import rotationsRouter from './rotations.js';
import scoresRouter from './scores.js';
import adminRouter from './admin.js';

const router = express.Router();

router.use('/characters', charactersRouter);
router.use('/guildes', guildesRouter);
router.use('/membres', membresRouter);
router.use('/rotations', rotationsRouter);
router.use('/scores', scoresRouter);
router.use('/admin', adminRouter);

export default router;