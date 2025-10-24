// Alternative : src/config/database.js
import { MongoClient } from 'mongodb';

let db = null;

export async function connectDB() {
  try {
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    db = client.db('schrift');
    console.log('✅ Connecté à MongoDB');
    return db;
  } catch (err) {
    console.error('❌ Connexion MongoDB échouée:', err);
    process.exit(1);
  }
}

export function getDB() {
  if (!db) {
    throw new Error('Base de données non initialisée');
  }
  return db;
}

// Utilisation dans les routes :
// import { getDB } from '../config/database.js';
// const db = getDB();
// const guildes = await db.collection('guildes').find();