import { gradeAnswer, matchFreeText, normalizeText, timeBonus } from '../../src/services/quiz/grading.js';
import { playerQuestion, sanitizeQuestion } from '../../src/services/quiz/questions.js';

const multiple = {
  answer_type: 'multiple',
  points: 3,
  options: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, text: id })),
  correct_ids: ['a', 'b', 'c'],
};

describe('multiple choice', () => {
  it('gives a share per right box and takes a share per wrong one', () => {
    expect(gradeAnswer(multiple, ['a', 'b', 'c']).points).toBe(3);
    expect(gradeAnswer(multiple, ['a', 'b']).points).toBe(2);
    expect(gradeAnswer(multiple, ['a', 'b', 'd']).points).toBe(1);
  });

  it('scores 0 when every box is ticked and never goes below 0', () => {
    expect(gradeAnswer(multiple, ['a', 'b', 'c', 'd', 'e', 'f']).points).toBe(0);
    expect(gradeAnswer(multiple, ['d', 'e']).points).toBe(0);
  });

  it('follows the guild example: 4 options, 2 right, 2 points', () => {
    const q = { ...multiple, points: 2, options: multiple.options.slice(0, 4), correct_ids: ['a', 'b'] };
    expect(gradeAnswer(q, ['a', 'b', 'c']).points).toBe(1);
    expect(gradeAnswer(q, ['a']).points).toBe(1);
  });
});

describe('other answer types', () => {
  it('grades single choice and true/false all or nothing', () => {
    expect(gradeAnswer({ answer_type: 'single', points: 1, correct_id: 'x' }, 'x').points).toBe(1);
    expect(gradeAnswer({ answer_type: 'single', points: 1, correct_id: 'x' }, 'y').points).toBe(0);
    expect(gradeAnswer({ answer_type: 'true_false', points: 0.5, correct_bool: false }, false).points).toBe(0.5);
    expect(gradeAnswer({ answer_type: 'true_false', points: 0.5, correct_bool: false }, 'false').points).toBe(0);
  });

  it('gives points per right pair and per item in place', () => {
    const match = { answer_type: 'match', points: 2, pairs: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }] };
    expect(gradeAnswer(match, { p1: 'p1', p2: 'p3', p3: 'p2', p4: 'p4' }).points).toBe(1);
    const order = { answer_type: 'order', points: 2, items: [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }, { id: 'i4' }] };
    expect(gradeAnswer(order, ['i1', 'i2', 'i4', 'i3']).points).toBe(1);
  });

  it('marks unanswered questions 0', () => {
    expect(gradeAnswer(multiple, null).points).toBe(0);
  });
});

describe('free text', () => {
  it('ignores case, accents, punctuation and small typos', () => {
    expect(normalizeText('  Tōshirō  Hitsugaya ! ')).toBe('toshiro hitsugaya');
    expect(matchFreeText('hyorinmaru', ['Hyōrinmaru'])).toBe('correct');
    expect(matchFreeText('hyorinmau', ['Hyōrinmaru'])).toBe('correct');
    expect(matchFreeText('ichigo', ['Ichigo Kurosaki', 'Ichigo'])).toBe('correct');
  });

  it('leaves close answers to a human and refuses the rest', () => {
    expect(matchFreeText('Ichigo Kurosaki le shinigami', ['Ichigo Kurosaki'])).toBe('pending');
    expect(matchFreeText('Renji', ['Byakuya'])).toBe('wrong');
    expect(matchFreeText('', ['Byakuya'])).toBe('wrong');
  });

  it('counts a pending answer once an admin accepts it', () => {
    const q = { answer_type: 'free_text', points: 2, accepted: ['Ichigo Kurosaki'] };
    expect(gradeAnswer(q, 'Ichigo Kurosaki le shinigami')).toEqual({ points: 0, max: 2, pending: ['text'] });
    expect(gradeAnswer(q, 'Ichigo Kurosaki le shinigami', ['text']).points).toBe(2);
  });

  it('grades each blank on its own', () => {
    const q = { answer_type: 'blanks', points: 2, blanks: [{ accepted: ['kai'] }, { accepted: ['Getsuga'] }] };
    expect(gradeAnswer(q, ['kai', 'nope']).points).toBe(1);
    expect(gradeAnswer(q, ['KAI', 'getsuga']).points).toBe(2);
  });
});

describe('time bonus', () => {
  it('only rewards points earned, in proportion to the time left', () => {
    expect(timeBonus({ points: 0, remainingMs: 30000, durationMs: 30000, ratio: 0.1 })).toBe(0);
    expect(timeBonus({ points: 2, remainingMs: 15000, durationMs: 30000, ratio: 0.1 })).toBe(0.1);
    expect(timeBonus({ points: 2, remainingMs: 30000, durationMs: 30000, ratio: 0.1 })).toBe(0.2);
  });
});

describe('questions', () => {
  it('refuses a question that cannot be played', () => {
    expect(() => sanitizeQuestion({ answer_type: 'single', prompt: 'Q', points: 1, options: [{ text: 'a' }, { text: 'b' }] }))
      .toThrow('choisis la bonne réponse');
    expect(() => sanitizeQuestion({ answer_type: 'free_text', support: 'image', prompt: 'Q', points: 1, accepted: ['a'] }))
      .toThrow('il manque le média');
    expect(() => sanitizeQuestion({ answer_type: 'blanks', prompt: 'Q', points: 1, blank_text: 'a [1] b [2]', blanks: [{ accepted: ['x'] }] }))
      .toThrow('chaque trou');
  });

  it('never sends the answers to the player', () => {
    const q = sanitizeQuestion({
      answer_type: 'order', prompt: 'Classe', points: 2,
      items: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }],
    });
    const shown = playerQuestion(q, 'seed');
    expect(shown.items.map((i) => i.id)).not.toEqual(['a', 'b', 'c']);
    expect(JSON.stringify(playerQuestion(sanitizeQuestion({
      answer_type: 'free_text', prompt: 'Q', points: 1, accepted: ['secret'],
    }), 's'))).not.toContain('secret');
  });
});
