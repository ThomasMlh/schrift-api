import express from 'express';
import { requireDb, requireAdmin, requireScoresAccess, canManageGuild } from '../middleware/auth.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';
import {
  addBonusTicket, cancelGuildDraw, drawGuildRaffle, getGuildRaffle, getRaffleMonths, getRaffleSettings,
  removeBonusTicket, saveRaffleSettings, setGuildLifeTicket, setGuildSRank, setSchriftSince,
} from '../services/raffle/index.js';

const router = express.Router();
router.use(requireDb);

// Leaders and officers act on their own guild only, admins on every guild
const requireGuildManager = [requireScoresAccess, (req, res, next) => {
  if (!canManageGuild(req.user, req.params.guildId)) {
    return res.status(403).json({ success: false, message: 'Accès refusé à cette guilde' });
  }
  next();
}];

// GET settings and months. Public: everyone can follow the raffle.
router.get('/', async (req, res) => {
  try {
    const [settings, months] = await Promise.all([getRaffleSettings(req.db), getRaffleMonths(req.db)]);
    const guilds = settings.guild_ids.length
      ? await req.db.collection('guildes').find({}, { projection: { name: 1 } }).toArray()
      : [];
    res.json({
      success: true,
      ...settings,
      guilds: guilds.filter((g) => settings.guild_ids.includes(g._id.toString())).map((g) => ({ _id: g._id.toString(), name: g.name })),
      months,
    });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la récupération de la tombola');
  }
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, settings: await saveRaffleSettings(req.db, req.body ?? {}) });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de l\'enregistrement des réglages');
  }
});

// GET a guild's tickets for a month. Public.
router.get('/:month/guilds/:guildId', async (req, res) => {
  try {
    res.json({ success: true, ...(await getGuildRaffle(req.db, { month: req.params.month, guildId: req.params.guildId })) });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors du calcul des tickets');
  }
});

// PUT { s_rank }: the guild moved up to or stayed in rank S this month
router.put('/:month/guilds/:guildId/s-rank', requireGuildManager, async (req, res) => {
  try {
    await setGuildSRank(req.db, { month: req.params.month, guildId: req.params.guildId, sRank: req.body?.s_rank === true, user: req.user });
    res.json({ success: true });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la mise à jour du rang S');
  }
});

// PUT { kind: 'farm'|'qg', period: 1|2, checked, bbs_name }
router.put('/:month/guilds/:guildId/players/:bbsId/guild-life', requireGuildManager, async (req, res) => {
  try {
    await setGuildLifeTicket(req.db, {
      month: req.params.month,
      guildId: req.params.guildId,
      bbsId: req.params.bbsId,
      bbsName: req.body?.bbs_name,
      kind: req.body?.kind,
      period: Number(req.body?.period),
      checked: req.body?.checked === true,
      user: req.user,
    });
    res.json({ success: true });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la mise à jour du ticket');
  }
});

// PUT { since: 'YYYY-MM' | null }: arrival date in Schrift, for the seniority tickets
router.put('/guilds/:guildId/players/:bbsId/since', requireGuildManager, async (req, res) => {
  try {
    await setSchriftSince(req.db, { guildId: req.params.guildId, bbsId: req.params.bbsId, since: req.body?.since ?? null, user: req.user });
    res.json({ success: true });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la mise à jour de la date d\'arrivée');
  }
});

// POST { label, count, bbs_name }: one-off activity tickets
router.post('/:month/guilds/:guildId/players/:bbsId/bonus', requireGuildManager, async (req, res) => {
  try {
    await addBonusTicket(req.db, {
      month: req.params.month,
      guildId: req.params.guildId,
      bbsId: req.params.bbsId,
      bbsName: req.body?.bbs_name,
      label: req.body?.label,
      count: req.body?.count,
      user: req.user,
    });
    res.status(201).json({ success: true });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de l\'ajout des tickets');
  }
});

router.delete('/:month/guilds/:guildId/bonus/:ticketId', requireGuildManager, async (req, res) => {
  try {
    await removeBonusTicket(req.db, { month: req.params.month, guildId: req.params.guildId, ticketId: req.params.ticketId });
    res.json({ success: true });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la suppression des tickets');
  }
});

// POST { announce }: draws the winner of a finished month, once
router.post('/:month/guilds/:guildId/draw', requireGuildManager, async (req, res) => {
  try {
    const result = await drawGuildRaffle(req.db, {
      month: req.params.month,
      guildId: req.params.guildId,
      user: req.user,
      announceOnDiscord: req.body?.announce !== false,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors du tirage');
  }
});

router.delete('/:month/guilds/:guildId/draw', requireAdmin, async (req, res) => {
  try {
    await cancelGuildDraw(req.db, { month: req.params.month, guildId: req.params.guildId });
    res.json({ success: true });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de l\'annulation du tirage');
  }
});

export default router;
