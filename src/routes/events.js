import express from 'express';
import { optionalAuth, requireAuth, requireDb } from '../middleware/auth.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';
import { getAttemptState, getPublicEvent, getResults, startAttempt, submitAnswer } from '../services/quiz/index.js';

const router = express.Router();
router.use(requireDb);

// GET the latest event of a kind (anniversary by default), with the player's state when logged in
router.get('/current', optionalAuth, async (req, res) => {
  try {
    res.json({ success: true, ...(await getPublicEvent(req.db, { kind: req.query.kind }, req.user)) });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la récupération de l\'événement');
  }
});

router.get('/quizzes/:quizId/results', optionalAuth, async (req, res) => {
  try {
    res.json({ success: true, ...(await getResults(req.db, req.params.quizId, req.user)) });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la récupération des résultats');
  }
});

// Starts the quiz, or resumes the attempt already started
router.post('/quizzes/:quizId/attempt', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, ...(await startAttempt(req.db, req.params.quizId, req.user)) });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors du lancement du quiz');
  }
});

router.get('/quizzes/:quizId/attempt', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, ...(await getAttemptState(req.db, req.params.quizId, req.user)) });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la récupération du quiz');
  }
});

// POST { question_id, answer }
router.post('/quizzes/:quizId/attempt/answer', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, ...(await submitAnswer(req.db, req.params.quizId, req.user, req.body ?? {})) });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de l\'envoi de la réponse');
  }
});

router.get('/:id', optionalAuth, async (req, res) => {
  try {
    res.json({ success: true, ...(await getPublicEvent(req.db, { id: req.params.id }, req.user)) });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la récupération de l\'événement');
  }
});

export default router;
