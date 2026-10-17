// Singleton holding the Mongo connection opened in server.js (initDb()), for modules that run
// outside the Express request cycle (no req.db available).
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

