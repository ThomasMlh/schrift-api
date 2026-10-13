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

// Body limit: 50mb comfortably covers OCR batches (at most 10 base64 screenshots, see routes/ocr.js)
// without exposing the API to memory exhaustion through huge bodies.
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb', extended: true}));

// CORS
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
    // Expose the DB to routes through app.locals
    app.locals.db = db;
    // and to modules outside the Express request cycle (e.g. notifyDiscord.js)
    setDb(db);

    logger.info('✅ Connecté à MongoDB');
  } catch (err) {
    logger.error('❌ Connexion MongoDB échouée:', err.message);
    // Without a database, exit so Passenger restarts the app
    process.exit(1);
  }
}
initDb();

app.get('/', (_req, res) => {
  res.send('API Schrift est en cours d\'exécution');
});

app.use('/api', apiRoutes);

// 404 for any unhandled /api route
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'Route introuvable' });
});

// Safety net for errors not handled by a route (synchronous throw, rejected promise passed to
// next(err), …), so no stack trace or internal error message leaks to the client.
app.use((err, _req, res, _next) => {
  logger.error('❌ Erreur non gérée:', err);
  res.status(err.status || 500).json({ success: false, message: 'Erreur serveur interne' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  logger.info(`API démarrée sur http://0.0.0.0:${port}`);
});