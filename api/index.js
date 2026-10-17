import * as dotenv from 'dotenv';

dotenv.config();

import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
import apiRoutes from '../src/routes/index.js';
import { setDb } from '../src/config/database.js';

const app = express();

app.use(express.json({limit: '1000mb'}));
app.use(express.urlencoded({limit: '1000mb', extended: true}));

// CORS (JWT in the Authorization header)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('❌ MONGODB_URI manquant');
  process.exit(1);
}

// MongoDB connection cached across serverless invocations (Vercel)
let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }

  try {
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });

    if(process.env.NODE_ENV === 'production') {
      console.log('⚠️  Mode production : connexion MongoDB optimisée pour Vercel');
      await client.connect();
      cachedDb = client.db('schrift');
    } else {
      console.log('⚠️  Mode développement : connexion MongoDB standard');
      await client.connect();
      cachedDb = client.db('schrift-test');
    }

    cachedClient = client;
    // Exposes the DB outside the Express request cycle (e.g. notifyDiscord.js)
    setDb(cachedDb);

    console.log('✅ Connecté à MongoDB');
    return { client: cachedClient, db: cachedDb };
  } catch (err) {
    console.error('❌ Connexion MongoDB échouée:', err.message);
    throw err;
  }
}

// Ensures the DB is connected for every request
app.use(async (req, res, next) => {
  try {
    const { db } = await connectToDatabase();
    req.app.locals.db = db;
    req.db = db;
    next();
  } catch (err) {
    console.error('Erreur de connexion DB:', err);
    res.status(503).json({ 
      success: false, 
      error: 'Service temporairement indisponible - problème de base de données' 
    });
  }
});

app.get('/', (_req, res) => {
  res.json({ 
    success: true, 
    message: 'API Schrift est en cours d\'exécution',
    timestamp: new Date().toISOString()
  });
});

app.use('/api', apiRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error('Erreur serveur:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Erreur interne du serveur' 
  });
});

// Local development
if (process.env.NODE_ENV !== 'production') {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`API démarrée sur http://0.0.0.0:${port}`);
  });
}

// Vercel entry point
export default app;