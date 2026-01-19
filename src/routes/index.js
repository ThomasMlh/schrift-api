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
import guidesRouter from './guides.js';
import buildsRouter from './builds.js';
import skillsRouter from './skills.js';
import accessoriesRouter from './accessories.js';
import accessoriesSubeffectRouter from './accessories_subeffect.js';
import podiumRouter from './podium.js';
import bannersRouter from './banners.js';

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
router.use('/guides', guidesRouter);
router.use('/builds', buildsRouter);
router.use('/skills', skillsRouter);
router.use('/accessories', accessoriesRouter);
router.use('/accessories-subeffect', accessoriesSubeffectRouter);
router.use('/podium', podiumRouter);
router.use('/banners', bannersRouter);

export default router;