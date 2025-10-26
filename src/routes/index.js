import express from 'express';
import charactersRouter from './characters.js';
import guildesRouter from './guildes.js';
import membresRouter from './membres.js';
import rotationsRouter from './rotations.js';
import cyclesRouter from './cycles.js';
import scoresRouter from './scores.js';
import adminRouter from './admin.js';
import authRouter from './auth.js';
import usersRouter from './users.js';

const router = express.Router();

router.use('/characters', charactersRouter);
router.use('/guildes', guildesRouter);
router.use('/membres', membresRouter);
router.use('/rotations', rotationsRouter);
router.use('/cycles', cyclesRouter);
router.use('/scores', scoresRouter);
router.use('/admin', adminRouter);
router.use('/auth', authRouter);
router.use('/users', usersRouter);

export default router;