import { listDiscordChannels, sendDiscordMessage } from '../../src/utils/botClient.js';

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('listDiscordChannels', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('returns the channels array on success', async () => {
    const channels = [{ id: '1', name: 'general', members: [] }];
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { channels }));

    const result = await listDiscordChannels();
    expect(result).toEqual(channels);
  });

  it('returns an empty array when the bot omits the channels field', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, {}));
    expect(await listDiscordChannels()).toEqual([]);
  });

  it('throws a 502 error when the bot is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(listDiscordChannels()).rejects.toMatchObject({ statusCode: 502 });
  });

  it('propagates the bot status code and message on a non-ok response', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(401, { error: 'Non autorisé' }));
    await expect(listDiscordChannels()).rejects.toMatchObject({ statusCode: 401, message: 'Non autorisé' });
  });
});

describe('sendDiscordMessage', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('sends the request and returns the bot response on success', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(200, { status: 'ok', message_id: '42', channel: '1' }));

    const result = await sendDiscordMessage({ channel_id: '1', content: 'hello <@2>', mention_user_ids: ['2'] });

    expect(result).toEqual({ status: 'ok', message_id: '42', channel: '1' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/send-message'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ channel_id: '1', content: 'hello <@2>', mention_user_ids: ['2'] }),
      })
    );
  });

  it('throws a 502 error when the bot is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(sendDiscordMessage({ channel_id: '1', content: 'hi' })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('propagates a 404 when the bot cannot find the channel', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(404, { error: 'Channel 1 introuvable' }));
    await expect(sendDiscordMessage({ channel_id: '1', content: 'hi' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'Channel 1 introuvable' });
  });

  it('maps an unexpected bot status (e.g. 500) to a generic 502', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse(500, {}));
    await expect(sendDiscordMessage({ channel_id: '1', content: 'hi' })).rejects.toMatchObject({ statusCode: 502 });
  });
});
