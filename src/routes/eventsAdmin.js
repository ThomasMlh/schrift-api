import express from 'express';
import { requireAdmin, requireDb } from '../middleware/auth.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';
import {
  createEvent, createQuiz, deleteAttempt, deleteEvent, deleteQuiz, getAttemptDetail, getEventById, getQuiz, getTestResult, getTestState,
  listAttempts, listEventQuizzes, listEvents, reviewAnswer, startTestAttempt, submitTestAnswer, updateEvent, updateQuiz,
} from '../services/quiz/index.js';
import { deleteMedia, listMedia, startUpload, uploadChunk, uploadImage } from '../services/quiz/media.js';
import {
  characterAccepted, deleteCase, listCaseAnswers, listCases, randomCharacter, reviewCaseAnswer, saveCase,
} from '../services/advent/index.js';
import { deleteSpot, describePath, listSpots, randomSpot, saveSpot } from '../services/hunt/index.js';
import { goalProgress } from '../services/eventGoal.js';

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

// Rehearsal of a quiz by an admin, draft or not, outside the event dates; never ranked
router.post('/quizzes/:quizId/test', handle('Erreur lors du lancement du test', async (req) => startTestAttempt(req.db, req.params.quizId, req.user)));
router.get('/quizzes/:quizId/test', handle('Erreur lors de la récupération du test', async (req) => getTestState(req.db, req.params.quizId, req.user)));
router.post('/quizzes/:quizId/test/answer', handle('Erreur lors de l\'envoi de la réponse', async (req) => submitTestAnswer(req.db, req.params.quizId, req.user, req.body ?? {})));
router.get('/quizzes/:quizId/test/result', handle('Erreur lors de la récupération du test', async (req) => ({ data: await getTestResult(req.db, req.params.quizId, req.user) })));

router.get('/attempts/:attemptId', handle('Erreur lors de la récupération de la participation', async (req) => ({ data: await getAttemptDetail(req.db, req.params.attemptId) })));
// POST { question_id, key, accept }
router.post('/attempts/:attemptId/review', handle('Erreur lors de la correction', async (req) => ({ data: await reviewAnswer(req.db, req.params.attemptId, req.body ?? {}) })));
router.delete('/attempts/:attemptId', handle('Erreur lors de la suppression de la participation', async (req) => { await deleteAttempt(req.db, req.params.attemptId); }));

// Advent calendar
router.get('/advent/characters/:characterId', handle('Erreur lors de la récupération du perso', async (req) => ({ data: await characterAccepted(req.db, req.params.characterId) })));
// POST { accept }
router.post('/advent/answers/:answerId/review', handle('Erreur lors de la correction', async (req) => ({ data: await reviewCaseAnswer(req.db, req.params.answerId, req.body?.accept) })));

// PUT { index, data }: base64 chunk of an audio or video upload
router.put('/media/:mediaId/chunk', handle('Erreur lors de l\'envoi du fichier', async (req) => ({ data: await uploadChunk(req.db, req.params.mediaId, req.body ?? {}) })));
router.delete('/media/:mediaId', handle('Erreur lors de la suppression du média', async (req) => { await deleteMedia(req.db, req.params.mediaId); }));

router.put('/:id', handle('Erreur lors de l\'enregistrement de l\'événement', async (req) => ({ data: await updateEvent(req.db, req.params.id, req.body) })));
router.delete('/:id', handle('Erreur lors de la suppression de l\'événement', async (req) => { await deleteEvent(req.db, req.params.id); }));
router.get('/:id/quizzes', handle('Erreur lors de la récupération des quiz', async (req) => ({ data: await listEventQuizzes(req.db, req.params.id) })));
router.post('/:id/quizzes', handle('Erreur lors de la création du quiz', async (req) => ({ data: await createQuiz(req.db, req.params.id, req.body ?? {}) })));
router.get('/:id/advent', handle('Erreur lors de la récupération du calendrier', async (req) => ({ data: await listCases(req.db, req.params.id) })));
router.get('/:id/advent/random', handle('Erreur lors du tirage', async (req) => ({ data: await randomCharacter(req.db, req.params.id) })));
// PUT { character_id, clue_type, settings, clue_text, accepted }
router.put('/:id/advent/:day', handle('Erreur lors de l\'enregistrement de la case', async (req) => ({ data: await saveCase(req.db, req.params.id, req.params.day, req.body ?? {}) })));
router.delete('/:id/advent/:day', handle('Erreur lors de la suppression de la case', async (req) => { await deleteCase(req.db, req.params.id, req.params.day); }));
router.get('/:id/advent/:day/answers', handle('Erreur lors de la récupération des réponses', async (req) => ({ data: await listCaseAnswers(req.db, req.params.id, req.params.day) })));
router.get('/:id/hunt', handle('Erreur lors de la récupération de la chasse', async (req) => ({ data: await listSpots(req.db, req.params.id) })));
// What a page shows (player, character…), to check a spot before saving it
router.get('/hunt/preview', handle('Erreur lors de la lecture de la page', async (req) => ({ data: await describePath(req.db, req.query.path) })));
router.get('/:id/hunt/random', handle('Erreur lors du tirage', async (req) => ({ data: await randomSpot(req.db, req.params.id) })));
router.put('/:id/hunt/:day', handle('Erreur lors de l\'enregistrement de la cachette', async (req) => ({ data: await saveSpot(req.db, req.params.id, req.params.day, req.body ?? {}) })));
router.delete('/:id/hunt/:day', handle('Erreur lors de la suppression de la cachette', async (req) => { await deleteSpot(req.db, req.params.id, req.params.day); }));
router.get('/:id/goal', handle('Erreur lors du calcul de l\'objectif', async (req) => ({ data: await goalProgress(req.db, await getEventById(req.db, req.params.id)) })));
router.get('/:id/media', handle('Erreur lors de la récupération des médias', async (req) => ({ data: await listMedia(req.db, req.params.id) })));
// POST { name, data }: image as a data URL
router.post('/:id/media/image', handle('Erreur lors de l\'envoi de l\'image', async (req) => ({ data: await uploadImage(req.db, req.params.id, req.body ?? {}) })));
// POST { kind, name, size, mime }: starts an audio or video upload
router.post('/:id/media/upload', handle('Erreur lors de l\'envoi du fichier', async (req) => ({ data: await startUpload(req.db, req.params.id, req.body ?? {}) })));

export default router;
