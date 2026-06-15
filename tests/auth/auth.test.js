import jwt from 'jsonwebtoken';
import { requireAdmin, requireScoresAccess, optionalAuth, validateObjectIdParam } from '../../src/middleware/auth.js';

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

describe('requireScoresAccess', () => {
  it('returns 401 when no token is provided', () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    requireScoresAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('grants full access to admin users', () => {
    const token = makeToken({ id: '1', is_admin: true });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    requireScoresAccess(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.hasFullAccess).toBe(true);
  });

  it('grants restricted access to a chef with a guilde_id', () => {
    const token = makeToken({ id: '2', role: 'chef', guilde_id: 'guild-1' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    requireScoresAccess(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.hasFullAccess).toBe(false);
    expect(req.user.allowedGuildId).toBe('guild-1');
  });

  it('returns 403 when a chef has no guilde_id', () => {
    const token = makeToken({ id: '3', role: 'chef' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    requireScoresAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 for a role without sufficient permissions', () => {
    const token = makeToken({ id: '4', role: 'membre' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    requireScoresAccess(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
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
