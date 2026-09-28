import Client from 'ssh2-sftp-client';
import { logger } from './logger.js';

export class SFTPClient {
  constructor() {
    this.client = new Client();
  }

  async connect(options) {
    logger.info(`Connecting to ${options.host}:${options.port}`);
    try {
      await this.client.connect(options);
    } catch (err) {
      logger.info('Failed to connect:', err);
    }
  }

  async disconnect() {
    await this.client.end();
  }

}