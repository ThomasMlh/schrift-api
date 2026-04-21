import * as dotenv from 'dotenv';

dotenv.config();

import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import apiRoutes from './routes/index.js';

const app = express();

// Configuration des middlewares
app.use(express.json({limit: '1000mb'}));
app.use(express.urlencoded({limit: '1000mb', extended: true}));

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
  PhusionPassenger.configure({ autoInstall: false });
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('❌ MONGODB_URI manquant');
  process.exit(1);
}
    console.log(uri);

const client = new MongoClient(uri);

let db;

const initDb = async () => {
  try {
    if(process.env.NODE_ENV === 'production') {
      console.log('⚠️  Mode production : connexion MongoDB optimisée pour Vercel');
      await client.connect();
      db = client.db('schrift');
    } else {
      console.log('⚠️  Mode développement : connexion MongoDB standard');
      await client.connect();
      db = client.db('schrift-test');
    }
    // Rendre la DB accessible aux routes via app.locals
    app.locals.db = db;
    
    console.log('✅ Connecté à MongoDB');
  } catch (err) {
    console.error('❌ Connexion MongoDB échouée:', err.message);
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


const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`API démarrée sur http://0.0.0.0:${port}`);
});