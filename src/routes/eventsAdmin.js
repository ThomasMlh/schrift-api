import express from 'express';
import { requireAdmin, requireDb } from '../middleware/auth.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';
import {
  createEvent, createQuiz, deleteAttempt, deleteEvent, deleteQuiz, getAttemptDetail, getQuiz, listAttempts, listEventQuizzes,
  listEvents, reviewAnswer, updateEvent, updateQuiz,
} from '../services/quiz/index.js';
import { deleteMedia, listMedia, startUpload, uploadChunk, uploadImage } from '../services/quiz/media.js';

const router = express.Router();
// Admin only: events and quizzes are built from the admin panel
router.use(requireDb, requireAdmin);

// Wraps a handler: its result is sent as { success: true, ...result }
const handle = (fallback, task) => async (req, res) => {
  try {
    res.json({ success: true, ...((await task(req)) ?? {}) });
  } catch (err) {
    sendStatusCodeError(res, err, fallback);
  }
};

router.get('/', handle('Erreur lors de la récupération des événements', async (req) => ({ data: await listEvents(req.db) })));
router.post('/', handle('Erreur lors de la création de l\'événement', async (req) => ({ data: await createEvent(req.db, req.body) })));

router.get('/quizzes/:quizId', handle('Erreur lors de la récupération du quiz', async (req) => ({ data: await getQuiz(req.db, req.params.quizId) })));
router.put('/quizzes/:quizId', handle('Erreur lors de l\'enregistrement du quiz', async (req) => ({ data: await updateQuiz(req.db, req.params.quizId, req.body ?? {}) })));
router.delete('/quizzes/:quizId', handle('Erreur lors de la suppression du quiz', async (req) => { await deleteQuiz(req.db, req.params.quizId); }));
router.get('/quizzes/:quizId/attempts', handle('Erreur lors de la récupération des participants', async (req) => ({ data: await listAttempts(req.db, req.params.quizId) })));

router.get('/attempts/:attemptId', handle('Erreur lors de la récupération de la participation', async (req) => ({ data: await getAttemptDetail(req.db, req.params.attemptId) })));
// POST { question_id, key, accept }
router.post('/attempts/:attemptId/review', handle('Erreur lors de la correction', async (req) => ({ data: await reviewAnswer(req.db, req.params.attemptId, req.body ?? {}) })));
router.delete('/attempts/:attemptId', handle('Erreur lors de la suppression de la participation', async (req) => { await deleteAttempt(req.db, req.params.attemptId); }));

// PUT { index, data }: base64 chunk of an audio or video upload
router.put('/media/:mediaId/chunk', handle('Erreur lors de l\'envoi du fichier', async (req) => ({ data: await uploadChunk(req.db, req.params.mediaId, req.body ?? {}) })));
router.delete('/media/:mediaId', handle('Erreur lors de la suppression du média', async (req) => { await deleteMedia(req.db, req.params.mediaId); }));

router.put('/:id', handle('Erreur lors de l\'enregistrement de l\'événement', async (req) => ({ data: await updateEvent(req.db, req.params.id, req.body) })));
router.delete('/:id', handle('Erreur lors de la suppression de l\'événement', async (req) => { await deleteEvent(req.db, req.params.id); }));
router.get('/:id/quizzes', handle('Erreur lors de la récupération des quiz', async (req) => ({ data: await listEventQuizzes(req.db, req.params.id) })));
router.post('/:id/quizzes', handle('Erreur lors de la création du quiz', async (req) => ({ data: await createQuiz(req.db, req.params.id, req.body ?? {}) })));
router.get('/:id/media', handle('Erreur lors de la récupération des médias', async (req) => ({ data: await listMedia(req.db, req.params.id) })));
// POST { name, data }: image as a data URL
router.post('/:id/media/image', handle('Erreur lors de l\'envoi de l\'image', async (req) => ({ data: await uploadImage(req.db, req.params.id, req.body ?? {}) })));
// POST { kind, name, size, mime }: starts an audio or video upload
router.post('/:id/media/upload', handle('Erreur lors de l\'envoi du fichier', async (req) => ({ data: await startUpload(req.db, req.params.id, req.body ?? {}) })));

export default router;
