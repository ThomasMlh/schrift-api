/**
 * An image upload is done in many small batches (the admin page calls them one after the other). The
 * whole run is followed here so Discord gets a few messages (start, 25 / 50 / 75 %, end) instead of one
 * per batch.
 */
import { notifyDiscord } from '../utils/notifyDiscord.js';

const RUN_ID = 'image_upload_run';
const MILESTONES = [25, 50, 75];
// A run left without news for this long was interrupted: the next batch starts a new one
const STALE_MS = 60 * 60 * 1000;

export const trackUploadRun = async (db, { remainingBefore, remainingAfter, uploaded, errors }, now = new Date()) => {
  const settings = db.collection('app_settings');
  let run = await settings.findOne({ _id: RUN_ID });
  const notifications = [];

  if (!run || now - new Date(run.updated_at) > STALE_MS) {
    run = { _id: RUN_ID, total: remainingBefore, uploaded: 0, errors: 0, reached: 0, started_at: now };
    if (remainingBefore > 0) notifications.push({ message: `Envoi des images lancé : ${remainingBefore} élément(s) à traiter` });
  }

  run.uploaded += uploaded;
  run.errors += errors;
  // Something new to upload may have been queued meanwhile
  run.total = Math.max(run.total, remainingAfter);
  const done = Math.max(0, run.total - remainingAfter);
  const percent = remainingAfter === 0 ? 100 : Math.floor((done / run.total) * 100);
  const statistics = { uploaded: run.uploaded, remaining: remainingAfter, errors: run.errors };

  if (remainingAfter === 0) {
    notifications.push({ message: `Envoi des images terminé : ${run.uploaded} image(s) envoyée(s)`, statistics });
    await settings.deleteOne({ _id: RUN_ID });
  } else {
    const milestone = MILESTONES.filter((m) => m <= percent && m > run.reached).pop();
    if (milestone) {
      notifications.push({ message: `Envoi des images : ${milestone} %`, statistics });
      run.reached = milestone;
    }
    await settings.updateOne({ _id: RUN_ID }, { $set: { ...run, updated_at: now } }, { upsert: true });
  }

  for (const notification of notifications) await notifyDiscord('image_upload', notification);
  return notifications;
};
