import jwt from 'jsonwebtoken';
import { requireAdmin, requireAuth, requireScoresAccess, canManageGuild, optionalAuth, validateObjectIdParam } from '../../src/middleware/auth.js';

const JWT_SECRET = 'test-secret';

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET;
});

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const makeToken = (payload) => jwt.sign(payload, JWT_SECRET);

describe('requireAdmin', () => {
  it('returns 401 when no token is provided', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the token is invalid', () => {
    const req = { headers: { authorization: 'Bearer invalid.token.here' } };
    const res = mockRes();
    const next = jest.fn();

    requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the token is valid but user is not admin', () => {
    const token = makeToken({ id: '123', is_admin: false });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    requireAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when the admin token is valid', () => {
    const token = makeToken({ id: '123', is_admin: true });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    requireAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.is_admin).toBe(true);
  });
});

// Minimal db: users looked up by _id (the middleware reads the current grants from there)
const fakeDb = (users) => ({
  collection: () => ({
    findOne: async ({ _id }) => users.find((u) => String(u._id) === String(_id)) ?? null,
  }),
});
const USER_ID = '64b000000000000000000001';
const chefReq = (users, payload = {}) => ({
  headers: { authorization: `Bearer ${makeToken({ _id: USER_ID, ...payload })}` },
  db: fakeDb(users),
});

describe('requireScoresAccess', () => {
  it('returns 401 when no token is provided', async () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    await requireScoresAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('grants full access to admin users', async () => {
    const token = makeToken({ id: '1', is_admin: true });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    await requireScoresAccess(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.hasFullAccess).toBe(true);
  });

  it('grants restricted access to the guild of a chef account', async () => {
    const req = chefReq([{ _id: USER_ID, bbs_accounts: [{ bbs_id: 'bbs-2', guilde_id: 'guild-1', role: 'chef' }] }]);
    const res = mockRes();
    const next = jest.fn();

    await requireScoresAccess(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.hasFullAccess).toBe(false);
    expect(req.user.allowedGuildIds).toEqual(['guild-1']);
  });

  it('grants access scoped to multiple guilds when the user has several chef/sous-chef accounts', async () => {
    const req = chefReq([{ _id: USER_ID, bbs_accounts: [
      { bbs_id: 'bbs-2', guilde_id: 'guild-1', role: 'chef' },
      { bbs_id: 'bbs-2-alt', guilde_id: 'guild-2', role: 'sous-chef' },
      { bbs_id: 'bbs-2-alt2', guilde_id: 'guild-3', role: 'membre' },
    ] }]);
    const res = mockRes();
    const next = jest.fn();

    await requireScoresAccess(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.allowedGuildIds.sort()).toEqual(['guild-1', 'guild-2']);
  });

  it('uses the current database grants, not the stale ones of the token', async () => {
    // Demoted since login: the token still claims the chef role
    const req = chefReq(
      [{ _id: USER_ID, bbs_accounts: [{ bbs_id: 'bbs-2', guilde_id: 'guild-1', role: 'membre' }] }],
      { guild_roles: [{ bbs_id: 'bbs-2', guilde_id: 'guild-1', role: 'chef' }] }
    );
    const res = mockRes();
    const next = jest.fn();

    await requireScoresAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 for a banned user, even with leader accounts', async () => {
    const req = chefReq([{ _id: USER_ID, is_banned: true, bbs_accounts: [{ bbs_id: 'bbs-2', guilde_id: 'guild-1', role: 'chef' }] }]);
    const res = mockRes();
    const next = jest.fn();

    await requireScoresAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when the user no longer exists', async () => {
    const req = chefReq([]);
    const res = mockRes();
    const next = jest.fn();

    await requireScoresAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 for a user without leader accounts', async () => {
    const req = chefReq([{ _id: USER_ID, bbs_accounts: [{ bbs_id: 'bbs-4', guilde_id: 'guild-1', role: 'membre' }] }]);
    const res = mockRes();
    const next = jest.fn();

    await requireScoresAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('requireAuth', () => {
  it('lets an existing user through', async () => {
    const req = chefReq([{ _id: USER_ID, bbs_accounts: [] }]);
    const next = jest.fn();

    await requireAuth(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 403 for a banned user', async () => {
    const req = chefReq([{ _id: USER_ID, is_banned: true }]);
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('canManageGuild', () => {
  it('allows admins on any guild and leaders on their guilds only', () => {
    expect(canManageGuild({ hasFullAccess: true }, 'g9')).toBe(true);
    expect(canManageGuild({ hasFullAccess: false, allowedGuildIds: ['g1'] }, 'g1')).toBe(true);
    expect(canManageGuild({ hasFullAccess: false, allowedGuildIds: ['g1'] }, 'g2')).toBe(false);
    expect(canManageGuild({ hasFullAccess: false, allowedGuildIds: ['g1'] }, undefined)).toBe(false);
  });
});

describe('optionalAuth', () => {
  it('populates req.user when the token is valid', () => {
    const token = makeToken({ id: '1', is_admin: false });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    optionalAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.id).toBe('1');
  });

  it('sets req.user to null when the token is invalid', () => {
    const req = { headers: { authorization: 'Bearer invalid' } };
    const res = mockRes();
    const next = jest.fn();

    optionalAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toBeNull();
  });

  it('calls next() without error when no token is present', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    optionalAuth(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

describe('validateObjectIdParam', () => {
  it('calls next() for a valid ObjectId', () => {
    const req = { params: { id: '507f1f77bcf86cd799439011' } };
    const res = mockRes();
    const next = jest.fn();

    validateObjectIdParam('id')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 400 for an invalid ObjectId', () => {
    const req = { params: { id: 'not-an-objectid' } };
    const res = mockRes();
    const next = jest.fn();

    validateObjectIdParam('id')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
