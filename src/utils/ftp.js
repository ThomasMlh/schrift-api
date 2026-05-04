import * as ftp from "basic-ftp";
import { Readable } from "stream";

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
    console.log("📁 FTP connecté à", process.env.FTP_HOST);
  }

  async disconnect() {
    this.client.close();
    console.log("📁 FTP déconnecté");
  }

  /**
   * Liste les sous-dossiers d'un répertoire FTP
   * @param {string} remotePath - Chemin du dossier à lister
   * @returns {string[]} Noms des sous-dossiers triés
   */
  async listSubdirectories(remotePath) {
    const list = await this.client.list(remotePath);
    return list
      .filter((item) => item.type === 2) // type 2 = directory
      .map((item) => item.name)
      .sort();
  }

  /**
   * Vérifie si un fichier existe sur le FTP
   * @param {string} remotePath - Chemin complet sur le FTP
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
   * Télécharge une image depuis une URL et l'upload sur le FTP
   * @param {string} imageUrl - URL source de l'image
   * @param {string} remotePath - Chemin de destination sur le FTP
   * @returns {boolean} true si l'upload a réussi
   */
  async downloadAndUpload(imageUrl, remotePath) {
    if (!imageUrl || typeof imageUrl !== "string" || !imageUrl.trim()) {
      return false;
    }

    try {
      const response = await fetch(imageUrl);
      if (!response.ok) {
        console.warn(`⚠️ HTTP ${response.status} pour ${imageUrl}`);
        return false;
      }

      // S'assurer que le dossier distant existe
      const dir = remotePath.substring(0, remotePath.lastIndexOf("/"));
      await this.client.ensureDir(dir);

      // Convertir le body en Node readable stream
      let stream;
      if (response.body && typeof Readable.fromWeb === "function") {
        stream = Readable.fromWeb(response.body);
      } else {
        // Fallback: lire tout en mémoire
        const buf = Buffer.from(await response.arrayBuffer());
        stream = Readable.from(buf);
      }

      await this.client.uploadFrom(stream, remotePath);
      return true;
    } catch (err) {
      console.error(`❌ Erreur upload FTP ${remotePath}:`, err.message);
      return false;
    }
  }
}
