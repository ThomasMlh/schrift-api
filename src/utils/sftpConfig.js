/**
 * Configuration SFTP partagée (personnages curés + master DB du jeu).
 */
export const buildSftpConfig = () => {
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
      kex: ['ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521', 'diffie-hellman-group14-sha256']
    },
    tryKeyboard: true
  };
  if (process.env.SFTP_PRIVATE_KEY) {
    config.privateKey = process.env.SFTP_PRIVATE_KEY;
    delete config.password;
  }
  return config;
}
