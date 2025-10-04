const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');
const dotenv = require('dotenv');
dotenv.config();

if (typeof PhusionPassenger !== 'undefined') {
  PhusionPassenger.configure({ autoInstall: false });
}

const app = express();
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error('MONGODB_URI is not defined in environment variables');
}
const client = new MongoClient(uri);
let db;
client.connect().then(() => {
  db = client.db('schrift');
  console.log('Connecté à MongoDB');
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

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
if (typeof PhusionPassenger !== 'undefined') {
  app.listen("passenger");
} else {
    const host = process.env.HOST || '0.0.0.0';
    const port = process.env.PORT || '3000';
    app.listen(port, () => {
    console.log(`Serveur backend démarré sur http://${host}:${port}`);
  });
}
