import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
const client = await MongoClient.connect(process.env.MONGODB_URI);
console.log(await client.db('schrift').collection('characters').findOne({ _id: new ObjectId('6ad9065851e0225b3658c89f') }, { projection: { name: 1, game_id: 1, game_version: 1 } }));
await client.close();
