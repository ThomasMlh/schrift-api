/**
 * SFTP server of the Discord bot, which keeps the character file (database.json) at its root.
 */
import Client from 'ssh2-sftp-client';

// The bot keeps the up-to-date character file at the SFTP root (/modules/database.json is a stale copy)
export const BOT_DATABASE_PATH = process.env.SFTP_CHARACTERS_PATH || '/database.json';

export const sftpConfig = () => {
  const config = {
    host: process.env.SFTP_HOST,
    username: process.env.SFTP_USERNAME,
    password: process.env.SFTP_PASSWORD,
    port: parseInt(process.env.SFTP_PORT) || 22,
    readyTimeout: parseInt(process.env.SFTP_TIMEOUT) || 30000,
    retries: parseInt(process.env.SFTP_RETRIES) || 3,
    algorithms: {
      cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-gcm', 'aes256-gcm'],
      hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'],
      kex: ['ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521', 'diffie-hellman-group14-sha256'],
    },
    tryKeyboard: true,
  };
  if (process.env.SFTP_PRIVATE_KEY) {
    config.privateKey = process.env.SFTP_PRIVATE_KEY;
    delete config.password;
  }
  return config;
};

// Runs work(client) on a connected SFTP client, always disconnected afterwards
export const withSftp = async (work) => {
  const config = sftpConfig();
  if (!config.host || !config.username || (!config.password && !config.privateKey)) {
    throw Object.assign(new Error('Configuration SFTP incomplète (SFTP_HOST, SFTP_USERNAME, SFTP_PASSWORD ou SFTP_PRIVATE_KEY)'), { statusCode: 500 });
  }
  const client = new Client();
  await client.connect(config);
  try {
    return await work(client);
  } finally {
    await client.end().catch(() => {});
  }
};
