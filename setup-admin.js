// Sets the admin password with a SHA-256 hash
// Usage: npm run setup-admin (node setup-admin.js)

import crypto from 'crypto';
import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';
import readline from 'readline';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function setupAdmin() {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      console.error('❌ MONGODB_URI manquant dans .env');
      process.exit(1);
    }
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db('schrift');

    console.log('✅ Connecté à MongoDB');
    
    rl.question('Entrez le mot de passe admin (minimum 6 caractères) : ', async (password) => {
      if (!password || password.length < 6) {
        console.log('❌ Le mot de passe doit faire au moins 6 caractères');
        rl.close();
        await client.close();
        return;
      }

      console.log('🔄 Génération du hash SHA-256...');
      
      // Same method as the front end
      const salt = process.env.PASSWORD_SALT;
      const passwordHash = crypto.createHash('sha256').update(password + salt).digest('hex');

      await db.collection('admin').replaceOne(
        { role: 'admin' },
        { 
          role: 'admin', 
          passwordHash: passwordHash, 
          createdAt: new Date(),
          updatedAt: new Date()
        },
        { upsert: true }
      );

      console.log('✅ Mot de passe admin configuré avec succès');
      console.log('🔐 Hash SHA-256:', passwordHash);
      console.log('🧂 Salt utilisé:', salt);
      console.log('');
      console.log('📋 Le front-end devra faire:');
      console.log('   const hash = crypto.createHash("sha256").update(password + "' + salt + '").digest("hex");');
      console.log('   fetch("/api/admin/login", { body: JSON.stringify({ passwordHash: hash }) });');
      console.log('');
      console.log('🔒 Le mot de passe ne transite JAMAIS en clair !');
      
      rl.close();
      await client.close();
    });

  } catch (err) {
    console.error('❌ Erreur:', err.message);
    process.exit(1);
  }
}

setupAdmin();