import { distance as levenshtein } from 'fastest-levenshtein';

// Grading of quiz answers. Every function is pure: a question (with its correct answers) and the
// player's answer in, the points out. Free text answers that are close but not clearly right are
// marked `pending`, so an admin can accept or refuse them before the results are revealed.

export const ANSWER_TYPES = ['multiple', 'single', 'true_false', 'match', 'order', 'free_text', 'blanks'];

// Time limit of a question, from what it shows
export const SUPPORT_DURATIONS = { text: 30, image: 45, video: 60, audio: 60 };

const round = (value) => Math.round(value * 100) / 100;

// "Kurosaki, Ichigo !" -> "kurosaki ichigo"; accents and long vowels (ō) are dropped
export const normalizeText = (text) => String(text ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

// Typos allowed for an expected answer of that length
const typoTolerance = (length) => (length <= 4 ? 0 : length <= 8 ? 1 : 2);

/**
 * 'correct' when the text matches an accepted answer give or take case, accents, punctuation and a few
 * typos; 'pending' when it is close enough for a human to decide; 'wrong' otherwise.
 */
export const matchFreeText = (text, accepted) => {
  const answer = normalizeText(text);
  if (!answer) return 'wrong';
  let close = false;
  for (const expected of (accepted ?? []).map(normalizeText).filter(Boolean)) {
    const distance = levenshtein(answer, expected);
    const tolerance = typoTolerance(expected.length);
    if (distance <= tolerance) return 'correct';
    const contains = Math.min(answer.length, expected.length) >= 3 && (answer.includes(expected) || expected.includes(answer));
    if (distance <= tolerance + 2 || contains) close = true;
  }
  return close ? 'pending' : 'wrong';
};

const ids = (value) => (Array.isArray(value) ? [...new Set(value.map(String))] : []);

/**
 * Points of an answer: { points, max, pending: [keys] }. A pending key names the part waiting for a
 * review ('text' for free text, the blank index for blanks); it scores 0 until accepted.
 * `accepted` lists the keys an admin already accepted.
 */
export const gradeAnswer = (question, answer, accepted = []) => {
  const max = Number(question.points) || 0;
  const result = (points, pending = []) => ({ points: round(Math.max(0, Math.min(max, points))), max, pending });
  if (answer === null || answer === undefined) return result(0);

  switch (question.answer_type) {
    case 'multiple': {
      const correct = new Set(ids(question.correct_ids));
      const wrongCount = (question.options ?? []).length - correct.size;
      const picked = ids(answer).filter((id) => (question.options ?? []).some((o) => o.id === id));
      const right = picked.filter((id) => correct.has(id)).length;
      const wrong = picked.length - right;
      // Ticking every option always scores 0
      const gain = correct.size ? max / correct.size : 0;
      const loss = wrongCount > 0 ? max / wrongCount : 0;
      return result(right * gain - wrong * loss);
    }
    case 'single':
      return result(String(answer) === String(question.correct_id) ? max : 0);
    case 'true_false':
      return result(answer === question.correct_bool ? max : 0);
    case 'match': {
      const pairs = question.pairs ?? [];
      if (!pairs.length || typeof answer !== 'object') return result(0);
      const right = pairs.filter((pair) => String(answer[pair.id]) === pair.id).length;
      return result((right / pairs.length) * max);
    }
    case 'order': {
      const items = question.items ?? [];
      const order = ids(answer);
      if (!items.length) return result(0);
      const right = items.filter((item, index) => order[index] === item.id).length;
      return result((right / items.length) * max);
    }
    case 'free_text': {
      const status = matchFreeText(answer, question.accepted);
      if (status === 'correct' || (status === 'pending' && accepted.includes('text'))) return result(max);
      return result(0, status === 'pending' ? ['text'] : []);
    }
    case 'blanks': {
      const blanks = question.blanks ?? [];
      if (!blanks.length || !Array.isArray(answer)) return result(0);
      const share = max / blanks.length;
      let points = 0;
      const pending = [];
      blanks.forEach((blank, index) => {
        const status = matchFreeText(answer[index], blank.accepted);
        if (status === 'correct' || (status === 'pending' && accepted.includes(String(index)))) points += share;
        else if (status === 'pending') pending.push(String(index));
      });
      return result(points, pending);
    }
    default:
      return result(0);
  }
};

/**
 * Time bonus of an answer: only what was earned counts, so a fast wrong answer gives nothing.
 * Over a whole quiz it is capped at ratio × the total points.
 */
export const timeBonus = ({ points, remainingMs, durationMs, ratio }) => {
  if (!(points > 0) || !(durationMs > 0)) return 0;
  const fraction = Math.max(0, Math.min(1, remainingMs / durationMs));
  return round(points * ratio * fraction);
};
