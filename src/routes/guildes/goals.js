import express from 'express';
import { ObjectId } from 'mongodb';
import { requireScoresAccess } from '../../middleware/auth.js';
import { getGuildGoals, setGuildGoals } from '../../services/guildGoals.js';
import { resolveCycle } from '../../services/guildTools.js';
import { sendStatusCodeError } from '../../utils/httpErrors.js';

const router = express.Router();

const findGuild = async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    res.status(400).json({ success: false, message: 'ID de guilde invalide' });
    return null;
  }
  const guild = await req.db.collection('guildes').findOne({ _id: new ObjectId(req.params.id) }, { projection: { name: 1 } });
  if (!guild) res.status(404).json({ success: false, message: 'Guilde non trouvée' });
  return guild;
};

// GET a guild's goals on a cycle (current cycle by default), with their progress. Public.
router.get('/:id/goals', async (req, res) => {
  try {
    const guild = await findGuild(req, res);
    if (!guild) return;
    const cycle = await resolveCycle(req.db, req.query.cycle_id);
    if (!cycle) return res.json({ success: true, cycle: null, goals: [] });

    const result = await getGuildGoals(req.db, cycle, req.params.id);
    res.json({ success: true, cycle: { _id: cycle._id.toString(), name: cycle.name, year: cycle.year }, ...result });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la récupération des objectifs');
  }
});

// PUT a guild's goals on a cycle: admin, or a leader/officer of this guild.
// Body: { cycle_id, goals: [{ type, target }] }; an empty list removes the goals.
router.put('/:id/goals', requireScoresAccess, async (req, res) => {
  try {
    if (!req.user.hasFullAccess && !(req.user.allowedGuildIds || []).includes(req.params.id)) {
      return res.status(403).json({ success: false, message: 'Accès refusé à cette guilde' });
    }
    const guild = await findGuild(req, res);
    if (!guild) return;
    const cycle = await resolveCycle(req.db, req.body.cycle_id);
    if (!cycle) return res.status(404).json({ success: false, message: 'Cycle non trouvé' });

    await setGuildGoals(req.db, { guildId: req.params.id, cycleId: cycle._id.toString(), goals: req.body.goals, user: req.user });
    const result = await getGuildGoals(req.db, cycle, req.params.id);
    res.json({ success: true, cycle: { _id: cycle._id.toString(), name: cycle.name, year: cycle.year }, ...result });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la mise à jour des objectifs');
  }
});

export default router;
