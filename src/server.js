import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import * as dotenv from 'dotenv';
import apiRoutes from './routes/index.js';

dotenv.config();

const app = express();

// Configuration des middlewares
app.use(express.json({limit: '1000mb'}));
app.use(express.urlencoded({limit: '1000mb', extended: true}));

// Configuration CORS simplifiée pour JWT
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
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

const client = new MongoClient(uri);

let db;

async function initDb() {
  try {
    await client.connect();
    db = client.db('schrift');
    
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