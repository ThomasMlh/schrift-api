import {
  sendServerError,
  sendServerErrorWithFlag,
  sendStatusCodeError,
  sendHiddenServiceError,
} from '../../src/utils/httpErrors.js';

const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('sendServerError', () => {
  it('always responds 500 with { error: message }', () => {
    const res = mockRes();
    sendServerError(res, new Error('boom'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'boom' });
  });
});

describe('sendServerErrorWithFlag', () => {
  it('always responds 500 with { success: false, error: message }', () => {
    const res = mockRes();
    sendServerErrorWithFlag(res, new Error('boom'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'boom' });
  });
});

describe('sendStatusCodeError', () => {
  it('uses the error status code and message when both are set (business error)', () => {
    const res = mockRes();
    const err = Object.assign(new Error('Guilde introuvable'), { statusCode: 404 });
    sendStatusCodeError(res, err, 'Erreur serveur');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Guilde introuvable' });
  });

  it('falls back to 500 and the fallback message when the error has no statusCode', () => {
    const res = mockRes();
    const err = new Error('');
    sendStatusCodeError(res, err, 'Erreur serveur générique');
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Erreur serveur générique' });
  });

  it('includes error.details when present, omits it otherwise', () => {
    const resWithDetails = mockRes();
    const errWithDetails = Object.assign(new Error('Bad'), { statusCode: 400, details: 'field X invalid' });
    sendStatusCodeError(resWithDetails, errWithDetails, 'fallback');
    expect(resWithDetails.json).toHaveBeenCalledWith({ success: false, message: 'Bad', details: 'field X invalid' });

    const resWithoutDetails = mockRes();
    sendStatusCodeError(resWithoutDetails, new Error('Bad'), 'fallback');
    expect(resWithoutDetails.json).toHaveBeenCalledWith({ success: false, message: 'Bad' });
  });

  it('accepts an explicit logLabel distinct from the fallback message', () => {
    const res = mockRes();
    const err = new Error('');
    sendStatusCodeError(res, err, 'Message client', 'Label de log interne');
    // Le comportement observable (réponse HTTP) ne dépend pas du logLabel ;
    // on vérifie juste qu'il ne fait pas planter l'appel et que le message
    // client reste bien le fallback fourni.
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Message client' });
  });
});

describe('sendHiddenServiceError', () => {
  it('surfaces the original message for a business error (non-500)', () => {
    const res = mockRes();
    const err = Object.assign(new Error('Rôle invalide'), { statusCode: 400 });
    sendHiddenServiceError(res, err, 'log label');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Rôle invalide' });
  });

  it('hides the error message behind the generic fallback on an unexpected 500', () => {
    const res = mockRes();
    const err = new Error('a raw internal stack-trace-like message');
    sendHiddenServiceError(res, err, 'log label');
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, message: 'Erreur serveur' });
  });

  it('uses a custom fallback message when provided', () => {
    const res = mockRes();
    const err = new Error('internal details');
    sendHiddenServiceError(res, err, 'log label', 'Erreur serveur lors de la récupération des statistiques');
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Erreur serveur lors de la récupération des statistiques',
    });
  });
});
