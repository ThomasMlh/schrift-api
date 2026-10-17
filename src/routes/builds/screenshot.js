import express from 'express';
import { ObjectId } from 'mongodb';
import { optionalAuth, validateObjectIdParam } from '../../middleware/auth.js';
import { logger } from '../../utils/logger.js';
import {
  decodeImage, toWebp, screenshotFilename, uploadScreenshot, removeScreenshot, MAX_SCREENSHOT_BYTES,
} from '../../services/buildScreenshots.js';

const router = express.Router();

/**
 * Loads the build and checks that the logged-in user is its author or an admin.
 * Returns the build, or null after sending the appropriate error.
 */
const loadEditableBuild = async (req, res) => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Authentification requise' });
    return null;
  }
  const build = await req.db.collection('builds').findOne({ _id: new ObjectId(req.params.id) });
  if (!build) {
    res.status(404).json({ success: false, message: 'Build non trouvé' });
    return null;
  }

  const userIdentifier = req.user.userId || req.user.discord_id;
  let currentUserId = null;
  if (userIdentifier) {
    const user = ObjectId.isValid(userIdentifier)
      ? await req.db.collection('users').findOne({ _id: new ObjectId(userIdentifier) })
      : await req.db.collection('users').findOne({ discord_id: userIdentifier });
    currentUserId = user?._id.toString() ?? null;
  }

  if (build.user_id !== currentUserId && req.user.is_admin !== true) {
    res.status(403).json({ success: false, message: "Vous n'avez pas la permission de modifier ce build" });
    return null;
  }
  return build;
};

// POST /builds/:id/screenshot - add or replace a build's screenshot ({ image: data URL })
router.post('/:id/screenshot', optionalAuth, validateObjectIdParam('id'), async (req, res) => {
  try {
    const build = await loadEditableBuild(req, res);
    if (!build) return;

    const buffer = decodeImage(req.body?.image);
    if (!buffer) {
      return res.status(400).json({
        success: false,
        message: `Image invalide ou trop lourde (${MAX_SCREENSHOT_BYTES / 1024 / 1024} Mo maximum)`,
      });
    }

    let webp;
    try {
      webp = await toWebp(buffer);
    } catch {
      return res.status(400).json({ success: false, message: "Le fichier envoyé n'est pas une image lisible" });
    }

    const filename = screenshotFilename(build._id.toString());
    await uploadScreenshot(webp, filename);
    await req.db.collection('builds').updateOne(
      { _id: build._id },
      { $set: { screenshot: filename, updated_at: new Date() } }
    );
    // The old screenshot is removed once the new one is stored
    if (build.screenshot && build.screenshot !== filename) await removeScreenshot(build.screenshot);

    res.json({ success: true, screenshot: filename });
  } catch (error) {
    logger.error("Erreur lors de l'envoi de la capture du build:", error);
    res.status(500).json({ success: false, message: "Erreur lors de l'envoi de la capture" });
  }
});

// DELETE /builds/:id/screenshot - remove a build's screenshot
router.delete('/:id/screenshot', optionalAuth, validateObjectIdParam('id'), async (req, res) => {
  try {
    const build = await loadEditableBuild(req, res);
    if (!build) return;

    await req.db.collection('builds').updateOne(
      { _id: build._id },
      { $set: { screenshot: null, updated_at: new Date() } }
    );
    await removeScreenshot(build.screenshot);

    res.json({ success: true, screenshot: null });
  } catch (error) {
    logger.error('Erreur lors de la suppression de la capture du build:', error);
    res.status(500).json({ success: false, message: 'Erreur lors de la suppression de la capture' });
  }
});

export default router;
