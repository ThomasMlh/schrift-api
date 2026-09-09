// Singleton d'accès à la connexion Mongo établie dans server.js (initDb()),
// pour les modules hors du cycle requête/réponse Express (pas de req.db disponible).
let db = null;

export const setDb = (database) => {
  db = database;
}

export const getDB = () => {
  if (!db) {
    throw new Error('Base de données non initialisée');
  }
  return db;
}

// Utilisation :
// import { getDB } from '../config/database.js';
// const db = getDB();
// const guildes = await db.collection('guildes').find();