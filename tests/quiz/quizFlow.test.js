import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import eventsRouter from '../../src/routes/events.js';
import eventsAdminRouter from '../../src/routes/eventsAdmin.js';
import {
  createEvent, createQuiz, getAttemptState, getResults, listAttempts, reviewAnswer, startAttempt, submitAnswer, updateQuiz,
} from '../../src/services/quiz/index.js';
import { setQuizMediaStorage, startUpload, uploadChunk } from '../../src/services/quiz/media.js';

jest.setTimeout(60000);
const JWT_SECRET = 'test-secret';

let mongod;
let client;
let db;
let app;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/admin/events', eventsAdminRouter);
  app.use('/api/events', eventsRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const bearer = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, JWT_SECRET)}` });
const START = new Date('2026-12-01T00:00:00Z');
const END = new Date('2026-12-31T23:59:00Z');
const at = (seconds) => new Date(START.getTime() + 3600_000 + seconds * 1000);

const seed = async () => {
  const { insertedId: guildId } = await db.collection('guildes').insertOne({ name: 'Schrift' });
  const { insertedId: oldGuild } = await db.collection('guildes').insertOne({ name: 'Old', disabled: true });
  const users = await db.collection('users').insertMany([
    { discord_id: 'm1', username: 'member', bbs_accounts: [{ bbs_id: 'b1', bbs_name: 'Member', guilde_id: guildId.toString(), is_primary: true }] },
    { discord_id: 'f1', username: 'free', bbs_accounts: [{ bbs_id: 'b2', bbs_name: 'Free', guilde_id: oldGuild.toString(), is_primary: true }] },
  ]);
  const event = await createEvent(db, { name: 'Anniversaire', kind: 'anniversary', start_at: START, end_at: END });
  const quiz = await createQuiz(db, event._id.toString(), { title: 'Quiz' });
  await updateQuiz(db, quiz._id.toString(), {
    status: 'published',
    questions: [
      { id: 'q1', answer_type: 'single', prompt: 'Zanpakutō de Hitsugaya ?', points: 1, options: [{ id: 'o1', text: 'Hyōrinmaru' }, { id: 'o2', text: 'Zabimaru' }], correct_id: 'o1' },
      { id: 'q2', answer_type: 'free_text', prompt: 'Héros ?', points: 2, accepted: ['Ichigo Kurosaki'] },
      { id: 'q3', answer_type: 'true_false', prompt: 'Vrai ?', points: 0.5, correct_bool: true },
    ],
  });
  const token = (u) => ({ _id: u.toString() });
  return { quizId: quiz._id.toString(), member: token(users.insertedIds[0]), free: token(users.insertedIds[1]) };
};

describe('playing a quiz', () => {
  it('serves one question at a time without its answer, and records the time left', async () => {
    const { quizId, member } = await seed();
    const first = await startAttempt(db, quizId, member, at(0));
    expect(first).toMatchObject({ status: 'in_progress', index: 0, total: 3 });
    expect(JSON.stringify(first.question)).not.toContain('correct');

    const second = await submitAnswer(db, quizId, member, { question_id: 'q1', answer: 'o1' }, at(10));
    expect(second.question.id).toBe('q2');
    // A late duplicate of the first answer is ignored
    expect((await submitAnswer(db, quizId, member, { question_id: 'q1', answer: 'o2' }, at(11))).ignored).toBe(true);
  });

  it('keeps one attempt per account and skips the questions that ran out while away', async () => {
    const { quizId, member } = await seed();
    await startAttempt(db, quizId, member, at(0));
    // Back 40 s later: q1 (30 s + 3 s of margin) is lost, q2 starts now
    const back = await startAttempt(db, quizId, member, at(40));
    expect(back.question.id).toBe('q2');
    expect(await db.collection('quiz_attempts').countDocuments()).toBe(1);
    const state = await getAttemptState(db, quizId, member, at(41));
    expect(state.answered).toBe(1);
  });

  it('snapshots the guild, hides results until the end, then ranks 3 ways', async () => {
    const { quizId, member, free } = await seed();
    const play = async (token, answers, t0) => {
      await startAttempt(db, quizId, token, at(t0));
      await submitAnswer(db, quizId, token, { question_id: 'q1', answer: answers[0] }, at(t0 + 5));
      await submitAnswer(db, quizId, token, { question_id: 'q2', answer: answers[1] }, at(t0 + 10));
      return submitAnswer(db, quizId, token, { question_id: 'q3', answer: answers[2] }, at(t0 + 15));
    };
    expect((await play(member, ['o1', 'ichigo kurosaki', true], 0)).status).toBe('finished');
    await play(free, ['o2', 'Ichigo Kurosaki le meilleur', true], 100);

    await expect(getResults(db, quizId, member, at(200))).rejects.toThrow('révélés');

    const attempts = await listAttempts(db, quizId, at(200));
    const freeAttempt = attempts.find((a) => a.name === 'Free');
    expect(freeAttempt).toMatchObject({ in_guild: false, pending: 1 });
    expect(attempts.find((a) => a.name === 'Member')).toMatchObject({ in_guild: true, guild_name: 'Schrift' });
    await reviewAnswer(db, freeAttempt.attempt_id.toString(), { question_id: 'q2', key: 'text', accept: true });

    const results = await getResults(db, quizId, member, new Date(END.getTime() + 1000));
    expect(results.rankings.all.map((r) => [r.name, r.rank])).toEqual([['Member', 1], ['Free', 2]]);
    expect(results.rankings.guild.map((r) => r.name)).toEqual(['Member']);
    expect(results.rankings.free.map((r) => [r.name, r.points])).toEqual([['Free', 2.5]]);
    expect(results.mine.points).toBe(3.5);
    expect(results.mine.bonus).toBeGreaterThan(0);
    expect(results.mine.bonus).toBeLessThanOrEqual(results.mine.max_bonus);
  });
});

describe('routes', () => {
  it('ask to log in to play and keep the editor to admins', async () => {
    const { quizId } = await seed();
    expect((await request(app).post(`/api/events/quizzes/${quizId}/attempt`)).status).toBe(401);
    expect((await request(app).get('/api/events/current')).body).toMatchObject({ success: true, event: { name: 'Anniversaire' } });
    expect((await request(app).get('/api/admin/events').set(bearer({ discord_id: 'm1', is_admin: false }))).status).toBe(403);
    const admin = await request(app).get(`/api/admin/events/quizzes/${quizId}`).set(bearer({ discord_id: 'a', is_admin: true }));
    expect(admin.body.data.questions[0].correct_id).toBe('o1');
  });
});

describe('media', () => {
  it('assembles an upload from its chunks in order', async () => {
    const files = new Map();
    setQuizMediaStorage({
      write: async (path, buffer) => files.set(path, buffer),
      append: async (path, buffer) => files.set(path, Buffer.concat([files.get(path), buffer])),
      remove: async (path) => files.delete(path),
    });
    const media = await startUpload(db, 'event', { kind: 'audio', name: 'opening.mp3', size: 6, mime: 'audio/mpeg' });
    await expect(uploadChunk(db, media._id.toString(), { index: 1, data: Buffer.from('def').toString('base64') })).rejects.toThrow('attendu');
    await uploadChunk(db, media._id.toString(), { index: 0, data: Buffer.from('abc').toString('base64') });
    const done = await uploadChunk(db, media._id.toString(), { index: 1, data: Buffer.from('def').toString('base64') });
    expect(done.status).toBe('ready');
    expect(files.get(media.path).toString()).toBe('abcdef');
    expect(media.path).toMatch(/^quiz\/event\/[a-f0-9]{24}\.mp3$/);
  });
});
