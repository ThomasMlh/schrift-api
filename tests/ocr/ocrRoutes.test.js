import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import ocrRouter from '../../src/routes/ocr.js';
import { setDb } from '../../src/config/database.js';

// The manual entry (scores/bulk.js) triggers an automatic podium capture ('podium_snapshot', sent to
// the members channel) in addition to the text summary; this covers the same behavior for the OCR
// entry (routes/ocr.js, POST /submit-batch).
//
// notifyDiscord logs every notification to `activity_log` BEFORE contacting the bot (see
// src/utils/notifyDiscord.js), so the trigger can be checked without mocks: the bot call fails (no bot
// runs in this test), which is non-blocking and does not prevent logging.
jest.setTimeout(60000);

const JWT_SECRET = 'test-secret';

let mongod;
let client;
let db;
let app;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.FRONTEND_URL = 'https://bbs-schrift.fr';
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
  setDb(db); // Required for notifyDiscord to log to activity_log

  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/ocr', ocrRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map(c => db.collection(c.name).deleteMany({})));
});

const adminToken = () => jwt.sign({ id: 'admin-1', is_admin: true }, JWT_SECRET);

describe('POST /api/ocr/submit-batch', () => {
  const seedFixtures = async () => {
    const guild = await db.collection('guildes').insertOne({
      name: 'Guilde Test',
      discord_channel_id: 'chefs-channel',
      discord_general_channel_id: 'membres-channel',
    });
    const guildId = guild.insertedId.toString();

    const cycle = await db.collection('cycles').insertOne({
      name: 'Cycle Test',
      year: 2026,
      rotations: [{ rotation_id: 'r1', position: 1, killer: 'Killer X', attack: 'R' }],
    });
    const cycleId = cycle.insertedId.toString();

    const user = await db.collection('users').insertOne({
      discord_id: 'd1',
      bbs_accounts: [{ bbs_id: 'bbs-1', bbs_name: 'Alice', guilde_id: guildId }],
    });
    const userId = user.insertedId.toString();

    return { guildId, cycleId, userId };
  };

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).post('/api/ocr/submit-batch').send({});
    expect(res.status).toBe(401);
  });

  it('inserts the scores and triggers both the text recap and the podium screenshot', async () => {
    const { guildId, cycleId, userId } = await seedFixtures();

    const res = await request(app)
      .post('/api/ocr/submit-batch')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        guild_id: guildId,
        cycle_id: cycleId,
        rotation_id: 'r1',
        scores: [{ user_id: userId, bbs_id: 'bbs-1', raw_score: 500000000 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.inserted).toBe(1);

    // Score actually persisted
    const score = await db.collection('scores').findOne({ bbs_id: 'bbs-1', cycle_id: cycleId });
    expect(score).not.toBeNull();
    expect(score.source).toBe('ocr');

    // Text summary sent to the leaders channel
    const textNotif = await db.collection('activity_log').findOne({ type: 'scores' });
    expect(textNotif).not.toBeNull();
    expect(textNotif.channel_id).toBe('chefs-channel');

    // Podium capture sent to the members channel
    const podiumNotif = await db.collection('activity_log').findOne({ type: 'podium_snapshot' });
    expect(podiumNotif).not.toBeNull();
    expect(podiumNotif.channel_id).toBe('membres-channel');
    expect(podiumNotif.data.podium_url).toContain('mode=rotation');
    expect(podiumNotif.data.podium_url).toContain('rotation=1');
    expect(podiumNotif.data.podium_url).toContain(encodeURIComponent('Guilde Test'));
  });

  it('does not trigger the podium screenshot when FRONTEND_URL is not configured', async () => {
    const { guildId, cycleId, userId } = await seedFixtures();
    const previousUrl = process.env.FRONTEND_URL;
    delete process.env.FRONTEND_URL;

    try {
      const res = await request(app)
        .post('/api/ocr/submit-batch')
        .set('Authorization', `Bearer ${adminToken()}`)
        .send({
          guild_id: guildId,
          cycle_id: cycleId,
          rotation_id: 'r1',
          scores: [{ user_id: userId, bbs_id: 'bbs-1', raw_score: 500000000 }],
        });

      expect(res.status).toBe(200);
      const podiumNotif = await db.collection('activity_log').findOne({ type: 'podium_snapshot' });
      expect(podiumNotif).toBeNull();
    } finally {
      process.env.FRONTEND_URL = previousUrl;
    }
  });

  it('announces a personal record when a new OCR score beats the account best from a previous cycle', async () => {
    const { guildId, cycleId, userId } = await seedFixtures();
    // Previous cycle on the same killer (rotation 'r1'), with a lower score for this account
    const previous = await db.collection('cycles').insertOne({
      name: 'Cycle Précédent', year: 2026, rotations: [{ rotation_id: 'r1', position: 1 }],
    });
    await db.collection('scores').insertOne({
      cycle_id: previous.insertedId.toString(), rotation_id: 'r1', bbs_id: 'bbs-1', bbs_name: 'Alice',
      user_id: userId, guild_id: guildId, score: 400000000, raw_score: 400000000, is_differential: false,
    });

    const res = await request(app)
      .post('/api/ocr/submit-batch')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        guild_id: guildId,
        cycle_id: cycleId,
        rotation_id: 'r1',
        scores: [{ user_id: userId, bbs_id: 'bbs-1', raw_score: 500000000 }],
      });

    expect(res.status).toBe(200);
    const recordNotif = await db.collection('activity_log').findOne({ type: 'personal_record' });
    expect(recordNotif).not.toBeNull();
    expect(recordNotif.channel_id).toBe('membres-channel');
    expect(recordNotif.data.records).toEqual([
      expect.objectContaining({ pseudo: 'Alice', previous_score: 400000000, new_score: 500000000 }),
    ]);
  });

  it('does not announce a record when the same OCR batch is submitted again (update, not creation)', async () => {
    const { guildId, cycleId, userId } = await seedFixtures();
    const previous = await db.collection('cycles').insertOne({
      name: 'Cycle Précédent', year: 2026, rotations: [{ rotation_id: 'r1', position: 1 }],
    });
    await db.collection('scores').insertOne({
      cycle_id: previous.insertedId.toString(), rotation_id: 'r1', bbs_id: 'bbs-1', bbs_name: 'Alice',
      user_id: userId, guild_id: guildId, score: 400000000, raw_score: 400000000, is_differential: false,
    });
    const body = {
      guild_id: guildId, cycle_id: cycleId, rotation_id: 'r1',
      scores: [{ user_id: userId, bbs_id: 'bbs-1', raw_score: 500000000 }],
    };

    await request(app).post('/api/ocr/submit-batch').set('Authorization', `Bearer ${adminToken()}`).send(body);
    await request(app).post('/api/ocr/submit-batch').set('Authorization', `Bearer ${adminToken()}`).send(body);

    expect(await db.collection('activity_log').countDocuments({ type: 'personal_record' })).toBe(1);
  });
});
