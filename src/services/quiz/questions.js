import { ObjectId } from 'mongodb';
import { ANSWER_TYPES, SUPPORT_DURATIONS } from './grading.js';

export const SUPPORTS = Object.keys(SUPPORT_DURATIONS);
const MAX_OPTIONS = { multiple: 6, single: 4 };
const MAX_ITEMS = 8;
const MAX_TEXT = 500;

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });
const text = (value, max = MAX_TEXT) => String(value ?? '').trim().slice(0, max);
const newId = () => new ObjectId().toString();
const keepId = (value) => (typeof value === 'string' && /^[a-z0-9]{1,32}$/i.test(value) ? value : newId());
const textList = (values) => (Array.isArray(values) ? values.map((v) => text(v, 120)).filter(Boolean) : []);

const options = (values, label) => {
  const list = (Array.isArray(values) ? values : [])
    .map((o) => ({ id: keepId(o?.id), text: text(o?.text, 200) }))
    .filter((o) => o.text);
  if (list.length < 2) throw badRequest(`${label} : au moins 2 propositions`);
  return list;
};

/**
 * Cleans a question sent by the editor. Throws a 400 with a readable message when it cannot be played.
 * `index` only serves the messages.
 */
export const sanitizeQuestion = (input, index = 0, mediaIds = new Set()) => {
  const label = `Question ${index + 1}`;
  const support = SUPPORTS.includes(input?.support) ? input.support : 'text';
  const answerType = input?.answer_type;
  if (!ANSWER_TYPES.includes(answerType)) throw badRequest(`${label} : type de réponse inconnu`);
  const prompt = text(input?.prompt);
  if (!prompt) throw badRequest(`${label} : l'énoncé est vide`);
  const mediaId = support === 'text' ? null : (input?.media_id ? String(input.media_id) : null);
  if (support !== 'text' && !mediaId) throw badRequest(`${label} : il manque le média`);
  if (mediaId && !mediaIds.has(mediaId)) throw badRequest(`${label} : média introuvable dans la médiathèque`);
  const points = Number(input?.points);
  if (!(points > 0) || points > 100) throw badRequest(`${label} : les points doivent être entre 0 et 100`);

  const question = {
    id: keepId(input?.id),
    support,
    answer_type: answerType,
    prompt,
    media_id: mediaId,
    points: Math.round(points * 100) / 100,
  };

  switch (answerType) {
    case 'multiple':
    case 'single': {
      const list = options(input.options, label);
      if (list.length > MAX_OPTIONS[answerType]) throw badRequest(`${label} : ${MAX_OPTIONS[answerType]} propositions au maximum`);
      const known = new Set(list.map((o) => o.id));
      if (answerType === 'multiple') {
        const correct = [...new Set((input.correct_ids ?? []).map(String))].filter((id) => known.has(id));
        if (!correct.length) throw badRequest(`${label} : coche au moins une bonne réponse`);
        return { ...question, options: list, correct_ids: correct };
      }
      if (!known.has(String(input.correct_id))) throw badRequest(`${label} : choisis la bonne réponse`);
      return { ...question, options: list, correct_id: String(input.correct_id) };
    }
    case 'true_false':
      if (typeof input.correct_bool !== 'boolean') throw badRequest(`${label} : choisis vrai ou faux`);
      return { ...question, correct_bool: input.correct_bool };
    case 'match': {
      const pairs = (Array.isArray(input.pairs) ? input.pairs : [])
        .map((p) => ({ id: keepId(p?.id), left: text(p?.left, 200), right: text(p?.right, 200) }))
        .filter((p) => p.left && p.right);
      if (pairs.length < 2 || pairs.length > MAX_ITEMS) throw badRequest(`${label} : entre 2 et ${MAX_ITEMS} paires`);
      return { ...question, pairs };
    }
    case 'order': {
      const items = (Array.isArray(input.items) ? input.items : [])
        .map((i) => ({ id: keepId(i?.id), text: text(i?.text, 200) }))
        .filter((i) => i.text);
      if (items.length < 2 || items.length > MAX_ITEMS) throw badRequest(`${label} : entre 2 et ${MAX_ITEMS} éléments à classer`);
      return { ...question, items };
    }
    case 'free_text': {
      const accepted = textList(input.accepted);
      if (!accepted.length) throw badRequest(`${label} : ajoute au moins une réponse acceptée`);
      return { ...question, accepted };
    }
    case 'blanks': {
      // "Ban... [1] ! [2] Getsuga Tenshō !": [n] marks the blanks, in order
      const blankText = text(input.blank_text, 1000);
      const blanks = (Array.isArray(input.blanks) ? input.blanks : []).map((b) => ({ accepted: textList(b?.accepted) }));
      const markers = blankText.match(/\[\d+\]/g) ?? [];
      if (!markers.length) throw badRequest(`${label} : marque les trous avec [1], [2]…`);
      if (markers.length !== blanks.length || blanks.some((b) => !b.accepted.length)) {
        throw badRequest(`${label} : chaque trou doit avoir au moins une réponse acceptée`);
      }
      return { ...question, blank_text: blankText, blanks };
    }
    default:
      throw badRequest(`${label} : type de réponse inconnu`);
  }
};

// Deterministic shuffle, so a reload shows the same order to the same player
export const seededShuffle = (list, seed) => {
  let state = [...String(seed)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) || 1;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

/** What a player sees of a question: never the correct answers. */
export const playerQuestion = (question, seed) => {
  const base = {
    id: question.id,
    support: question.support,
    answer_type: question.answer_type,
    prompt: question.prompt,
    points: question.points,
    duration: SUPPORT_DURATIONS[question.support],
  };
  switch (question.answer_type) {
    case 'multiple':
    case 'single':
      return { ...base, options: question.options.map(({ id, text: t }) => ({ id, text: t })) };
    case 'match':
      return {
        ...base,
        lefts: question.pairs.map(({ id, left }) => ({ id, text: left })),
        rights: seededShuffle(question.pairs.map(({ id, right }) => ({ id, text: right })), `${seed}-${question.id}`),
      };
    case 'order': {
      const items = question.items.map(({ id, text: t }) => ({ id, text: t }));
      const shuffled = seededShuffle(items, `${seed}-${question.id}`);
      // Never hand out the answer already in order
      return { ...base, items: shuffled.every((item, i) => item.id === items[i].id) ? [...shuffled.slice(1), shuffled[0]] : shuffled };
    }
    case 'blanks':
      return { ...base, blank_text: question.blank_text, blank_count: question.blanks.length };
    default:
      return base;
  }
};

// The correct answer in a readable form, for the results once the event is over
export const correctAnswer = (question) => {
  switch (question.answer_type) {
    case 'multiple': return question.options.filter((o) => question.correct_ids.includes(o.id)).map((o) => o.text);
    case 'single': return [question.options.find((o) => o.id === question.correct_id)?.text].filter(Boolean);
    case 'true_false': return [question.correct_bool];
    case 'match': return question.pairs.map((p) => `${p.left} → ${p.right}`);
    case 'order': return question.items.map((i) => i.text);
    case 'free_text': return question.accepted.slice(0, 1);
    case 'blanks': return question.blanks.map((b) => b.accepted[0]);
    default: return [];
  }
};
