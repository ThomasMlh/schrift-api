import express, { application } from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import * as dotenv from 'dotenv';
dotenv.config();

if (typeof (PhusionPassenger) !== 'undefined') {
  PhusionPassenger.configure({ autoInstall: false });
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('❌ MONGODB_URI manquant');
  process.exit(1);
}

const client = new MongoClient(uri, {
  // keepAlive aide sur certains hébergements
  keepAlive: true,
});

let db;

async function initDb() {
  try {
    await client.connect();
    db = client.db('schrift');
    console.log('✅ Connecté à MongoDB');
  } catch (err) {
    console.error('❌ Connexion MongoDB échouée:', err.message);
    // si la DB est indispensable, on stoppe pour que Passenger relance
    process.exit(1);
  }
}
initDb();

// Middleware simple pour éviter d’appeler la DB avant qu’elle soit prête
function requireDb(req, res, next) {
  if (!db) return res.status(503).json({ error: 'DB non prête' });
  next();
}

app.get('/', (_req, res) => {
  res.send('API Schrift est en cours d\'exécution');
});

// Récupérer toutes les guildes
app.get('/api/guildes', async (_req, res) => {
  try {
    const guildes = await db.collection('guildes').find().toArray();
    res.json(guildes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer les membres d'une guilde
app.get('/api/guildes/:id/membres', async (req, res) => {
  try {
    const membres = await db.collection('membres').find({ guilde_id: req.params.id }).toArray();
    res.json(membres);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ajouter une guilde
app.post('/api/guildes', async (req, res) => {
  try {
    const result = await db.collection('guildes').insertOne(req.body);
    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Renommer une guilde
app.put('/api/guildes/:id', async (req, res) => {
  try {
    await db.collection('guildes').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { name: req.body.name } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer une guilde
app.delete('/api/guildes/:id', async (req, res) => {
  try {
    await db.collection('guildes').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ajouter un membre à une guilde
app.post('/api/guildes/:id/membres', async (req, res) => {
  try {
    const membre = { ...req.body, guilde_id: req.params.id };
    const result = await db.collection('membres').insertOne(membre);
    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer un membre
app.delete('/api/membres/:id', async (req, res) => {
  try {
    await db.collection('membres').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rotations (CRUD basique)
app.get('/api/rotations', async (_req, res) => {
  try {
    const rotations = await db.collection('rotations').find().toArray();
    res.json(rotations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rotations', async (req, res) => {
  try {
    const result = await db.collection('rotations').insertOne(req.body);
    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scores (CRUD basique)
app.get('/api/scores', async (_req, res) => {
  try {
    const scores = await db.collection('scores').find().toArray();
    res.json(scores);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scores', async (req, res) => {
  try {
    const result = await db.collection('scores').insertOne(req.body);
    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, '127.0.0.1', () => {
  console.log(`API démarrée sur http://127.0.0.1:${port}`);
});