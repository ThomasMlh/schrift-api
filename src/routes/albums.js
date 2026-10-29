import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAuth } from '../middleware/auth.js';
import { sendHiddenServiceError } from '../utils/httpErrors.js';
import { buildGuildRoles, getGuildAccountRoster } from '../utils/bbsAccounts.js';
import { leadersCanEditAlbums } from '../services/albumSettings.js';
import { logActivity } from '../utils/activityLog.js';
import { getUserDisplayName } from '../utils/nameMatching.js';
import { USER_DISPLAY } from '../utils/projections.js';

// Character albums: one document per bbs account (keyed by bbs_id, like the score history, so the
// album follows the account when it is transferred between users).
// characters = { <character _id>: spec }: a listed character is owned (spec 1 by default, up to 5
// with duplicates), a missing one is not.
const router = express.Router();

export const MAX_SPE = 5;

router.use(requireDb);

// Does the bbs account exist, which user owns it and which guild is it in?
const findAccount = async (db, bbsId) => {
  const owner = await db.collection('users').findOne(
    { $or: [{ 'bbs_accounts.bbs_id': bbsId }, { bbs_id: bbsId }] },
    { projection: { _id: 1, bbs_id: 1, bbs_name: 1, guilde_id: 1, bbs_accounts: 1 } }
  );
  if (!owner) return null;
  const account = (owner.bbs_accounts || []).find(a => a.bbs_id === bbsId);
  const guildeId = account ? account.guilde_id : (owner.bbs_id === bbsId ? owner.guilde_id : null);
  return {
    ownerId: String(owner._id),
    guildeId: guildeId ? String(guildeId) : null,
    bbsName: account?.bbs_name || owner.bbs_name || bbsId,
  };
};

// Guilds where the user leads one of their accounts (chef or sous-chef), read from the database since
// the token may be older than a role change
const ledGuildIds = async (db, user) => {
  if (!user?._id || !ObjectId.isValid(user._id)) return [];
  const doc = await db.collection('users').findOne({ _id: new ObjectId(user._id) }, { projection: { bbs_accounts: 1 } });
  return buildGuildRoles(doc?.bbs_accounts).map(g => String(g.guilde_id)).filter(Boolean);
};

// The account owner, an admin, or a leader of the guild the account is in when admins allow it
const canEditAlbum = async (db, user, account) => {
  if (user.is_admin || account.ownerId === String(user._id)) return true;
  if (!account.guildeId || !(await leadersCanEditAlbums(db))) return false;
  return (await ledGuildIds(db, user)).includes(account.guildeId);
};

const albumPayload = (bbsId, album) => ({
  bbs_id: bbsId,
  characters: album?.characters || {},
  updated_at: album?.updated_at || null,
});

// GET the albums of every bbs account in a guild (logged-in users only). `characters` is null for an
// account that never filled its album, so it can be told apart from an empty one.
router.get('/guild/:guildeId', requireAuth, async (req, res) => {
  try {
    const roster = await getGuildAccountRoster(req.db, req.params.guildeId);
    const albums = await req.db.collection('albums')
      .find({ bbs_id: { $in: roster.map(m => m.bbs_id).filter(Boolean) } }, { projection: { bbs_id: 1, characters: 1 } })
      .toArray();
    const byBbsId = new Map(albums.map(a => [a.bbs_id, a.characters || {}]));

    res.json({
      success: true,
      data: roster.map(member => ({ ...member, characters: byBbsId.get(member.bbs_id) ?? null }))
    });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la récupération des albums de la guilde:');
  }
});

// GET an account's album (public)
router.get('/:bbsId', async (req, res) => {
  try {
    const { bbsId } = req.params;
    const album = await req.db.collection('albums').findOne({ bbs_id: bbsId });

    res.json({ success: true, data: albumPayload(bbsId, album) });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la récupération de l\'album:');
  }
});

// Added, removed and changed characters, with their names, for the activity log
const describeChanges = (before, changes, characters) => {
  const byId = new Map(characters.map(c => [String(c._id), c]));
  const label = (id) => {
    const c = byId.get(id);
    return { name: c?.name || id, version: c?.version || c?.game_version?.fr || '' };
  };
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, spe] of Object.entries(changes)) {
    const from = before[id] ?? 0;
    if (from === spe) continue;
    if (from === 0) added.push({ ...label(id), spe });
    else if (spe === 0) removed.push({ ...label(id), spe: from });
    else changed.push({ ...label(id), from, to: spe });
  }
  return { added, removed, changed };
};

// PUT every change of an editing session at once (account owner, admin, or a leader of its guild).
// Body: { changes: { <character _id>: spe } }, spe = 0 removes the character from the album.
router.put('/:bbsId', requireAuth, async (req, res) => {
  try {
    const { bbsId } = req.params;
    const changes = req.body?.changes;

    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      return res.status(400).json({ success: false, message: 'changes doit être un objet { personnage: spé }' });
    }
    const entries = Object.entries(changes);
    for (const [characterId, spe] of entries) {
      if (!ObjectId.isValid(characterId)) {
        return res.status(400).json({ success: false, message: 'Format d\'ID personnage invalide' });
      }
      if (!Number.isInteger(spe) || spe < 0 || spe > MAX_SPE) {
        return res.status(400).json({ success: false, message: `spe doit être un entier entre 0 et ${MAX_SPE}` });
      }
    }

    const account = await findAccount(req.db, bbsId);
    if (!account) {
      return res.status(404).json({ success: false, message: 'Compte bbs introuvable' });
    }
    if (!(await canEditAlbum(req.db, req.user, account))) {
      return res.status(403).json({ success: false, message: 'Tu ne peux modifier que l\'album de tes comptes ou des joueurs de ta guilde' });
    }

    const albums = req.db.collection('albums');
    const current = await albums.findOne({ bbs_id: bbsId });
    if (entries.length === 0) return res.json({ success: true, data: albumPayload(bbsId, current) });

    const characters = await req.db.collection('characters').find(
      { _id: { $in: entries.map(([id]) => new ObjectId(id)) } },
      { projection: { name: 1, version: 1, 'game_version.fr': 1 } }
    ).toArray();
    if (characters.length !== entries.length) {
      return res.status(404).json({ success: false, message: 'Personnage non trouvé' });
    }

    const summary = describeChanges(current?.characters || {}, changes, characters);
    const set = { updated_at: new Date() };
    const unset = {};
    for (const [characterId, spe] of entries) {
      if (spe === 0) unset[`characters.${characterId}`] = '';
      else set[`characters.${characterId}`] = spe;
    }
    const album = await albums.findOneAndUpdate(
      { bbs_id: bbsId },
      { $set: set, ...(Object.keys(unset).length > 0 && { $unset: unset }) },
      { upsert: true, returnDocument: 'after' }
    );

    if (summary.added.length + summary.removed.length + summary.changed.length > 0) {
      const [editor, guild] = await Promise.all([
        ObjectId.isValid(req.user._id)
          ? req.db.collection('users').findOne({ _id: new ObjectId(req.user._id) }, { projection: USER_DISPLAY })
          : null,
        account.guildeId && ObjectId.isValid(account.guildeId)
          ? req.db.collection('guildes').findOne({ _id: new ObjectId(account.guildeId) }, { projection: { name: 1 } })
          : null,
      ]);
      await logActivity(req.db, {
        type: 'album_update',
        guildeId: account.guildeId,
        data: {
          edited_by: getUserDisplayName(editor),
          bbs_id: bbsId,
          bbs_name: account.bbsName,
          guild_name: guild?.name || null,
          ...summary,
        },
      });
    }

    res.json({ success: true, data: albumPayload(bbsId, album) });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la mise à jour de l\'album:');
  }
});

export default router;
