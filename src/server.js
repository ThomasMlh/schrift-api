import * as dotenv from 'dotenv';

dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { MongoClient } from 'mongodb';
import apiRoutes from './routes/index.js';
import { setDb } from './config/database.js';
import { logger } from './utils/logger.js';

const app = express();

app.use(helmet());

// Configuration des middlewares
// 50mb couvre large les batches OCR (max 10 screenshots en base64, cf.
// routes/ocr.js) ; 1000mb n'avait aucune justification et exposait l'API
// à un épuisement mémoire via des bodies volumineux.
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true}));

// Configuration CORS
const allowedOrigins = process.env.NODE_ENV === 'production'
  ? ['https://www.bbs-schrift.fr', 'https://bbs-schrift.fr']
  : ['http://localhost:5173'];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

if (typeof (PhusionPassenger) !== 'undefined') {
  // eslint-disable-next-line no-undef
  PhusionPassenger.configure({ autoInstall: false });
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  logger.error('❌ MONGODB_URI manquant');
  process.exit(1);
}

const client = new MongoClient(uri);

let db;

const initDb = async () => {
  try {
    if(process.env.NODE_ENV === 'production') {
      logger.info('⚠️  Mode production : connexion MongoDB optimisée pour Vercel');
      await client.connect();
      db = client.db('schrift');
    } else {
      logger.info('⚠️  Mode développement : connexion MongoDB standard');
      await client.connect();
      db = client.db('schrift-test');
    }
    // Rendre la DB accessible aux routes via app.locals
    app.locals.db = db;
    // Et aux modules hors requête Express (ex: notifyDiscord.js)
    setDb(db);

    logger.info('✅ Connecté à MongoDB');
  } catch (err) {
    logger.error('❌ Connexion MongoDB échouée:', err.message);
    // si la DB est indisponsable, on stoppe pour que Passenger relance
    process.exit(1);
  }
}
initDb();

// Route racine
app.get('/', (_req, res) => {
  res.send('API Schrift est en cours d\'exécution');
});

app.use('/api', apiRoutes);

// 404 pour toute route /api non gérée
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'Route introuvable' });
});

// Filet de sécurité : capture toute erreur non gérée par une route (throw
// synchrone, rejet de Promise transmis via next(err), etc.) pour éviter de
// laisser fuiter une stack trace ou un message d'erreur interne au client.
app.use((err, _req, res, _next) => {
  logger.error('❌ Erreur non gérée:', err);
  res.status(err.status || 500).json({ success: false, message: 'Erreur serveur interne' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  logger.info(`API démarrée sur http://0.0.0.0:${port}`);
});