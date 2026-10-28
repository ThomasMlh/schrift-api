import * as ftp from "basic-ftp";
import { Readable, Writable } from "stream";
import { logger } from './logger.js';

export class FTPUploader {
  constructor() {
    this.client = new ftp.Client();
    this.client.ftp.verbose = false;
  }

  async connect() {
    await this.client.access({
      host: process.env.FTP_HOST,
      port: parseInt(process.env.FTP_PORT) || 21,
      user: process.env.FTP_USERNAME,
      password: process.env.FTP_PASSWORD,
      secure: false,
    });
    logger.info("📁 FTP connecté à", process.env.FTP_HOST);
  }

  async disconnect() {
    this.client.close();
    logger.info("📁 FTP déconnecté");
  }

  /**
   * Lists the subfolders of an FTP directory
   * @param {string} remotePath - Folder to list
   * @returns {string[]} Sorted subfolder names
   */
  async listSubdirectories(remotePath) {
    const list = await this.client.list(remotePath);
    return list
      .filter((item) => item.type === 2) // type 2 = directory
      .map((item) => item.name)
      .sort();
  }

  /**
   * Whether a file exists on the FTP
   * @param {string} remotePath - Full FTP path
   * @returns {boolean}
   */
  async fileExists(remotePath) {
    try {
      const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
      const filename = remotePath.substring(remotePath.lastIndexOf("/") + 1);
      const list = await this.client.list(dir);
      return list.some((item) => item.name === filename);
    } catch {
      return false;
    }
  }

  /**
   * Uploads a buffer (e.g. an already processed image) to the FTP, creating the folder when needed
   * @param {Buffer} buffer - File content
   * @param {string} remotePath - FTP destination path
   */
  // Missing file: status 404. Its existence is checked first, as this server drops the connection
  // when a download of a missing file is attempted.
  async downloadBuffer(remotePath) {
    try {
      await this.client.size(remotePath);
    } catch (err) {
      if (err.code === 550) throw Object.assign(new Error(`Fichier introuvable : ${remotePath}`), { status: 404 });
      throw err;
    }
    const chunks = [];
    const sink = new Writable({ write: (chunk, encoding, done) => { chunks.push(chunk); done(); } });
    await this.client.downloadTo(sink, remotePath);
    return Buffer.concat(chunks);
  }

  async uploadBuffer(buffer, remotePath) {
    const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
    await this.client.ensureDir(dir);
    await this.client.uploadFrom(Readable.from(buffer), remotePath);
  }

  /**
   * Deletes a file from the FTP (no error when it is already gone)
   * @param {string} remotePath - Full FTP path
   */
  async removeFile(remotePath) {
    try {
      await this.client.remove(remotePath);
    } catch (err) {
      logger.warn(`⚠️ Suppression FTP impossible (${remotePath}): ${err.message}`);
    }
  }

  /**
   * Downloads an image from a URL and uploads it to the FTP
   * @param {string} imageUrl - Source image URL
   * @param {string} remotePath - FTP destination path
   * @returns {boolean} true when the upload succeeded
   */
  async downloadAndUpload(imageUrl, remotePath) {
    if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
      return false;
    }

    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        logger.warn(`⚠️ HTTP ${response.status} pour ${imageUrl}`);
        return false;
      }

      // Make sure the remote folder exists
      const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
      await this.client.ensureDir(dir);

      // Convert the body into a Node readable stream
      let stream;
      if (response.body && typeof Readable.fromWeb === "function") {
        stream = Readable.fromWeb(response.body);
      } else {
        // Fallback: read everything into memory
        const buf = Buffer.from(await response.arrayBuffer());
        stream = Readable.from(buf);
      }

      await this.client.uploadFrom(stream, remotePath);
      return true;
    } catch (err) {
      logger.error(`❌ Erreur upload FTP ${remotePath}:`, err.message);
      return false;
    }
  }
}
