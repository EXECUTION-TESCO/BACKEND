// Verifies: MongoDB connection, collections, read/write, password hashing and JWT signing.
// Read-only for your data: it only writes and deletes one temporary document in "ep_healthcheck".
// Run:  npm run db:check
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';
import { connectDB, User, Project, Report, Comment, Notification } from '../src/db.js';
import { hashPassword, checkPassword } from '../src/auth.js';

const ok = (m) => console.log('  ✔', m);
const bad = (m) => { console.log('  ✘', m); process.exitCode = 1; };
const masked = config.mongoUri.replace(/\/\/[^@]+@/, '//***:***@').replace(/@([^/,]+)[^/]*/, '@$1…');

console.log('\nExecution Portal – database & auth check');
console.log('  URI:', masked);
try {
  const db = await connectDB();
  ok(`Connected to MongoDB, database "${db.databaseName}"`);
  const cols = (await db.listCollections().toArray()).map((c) => c.name).sort();
  const ours = cols.filter((c) => c.startsWith(config.collectionPrefix));
  ok(`${cols.length} collection(s) in the database, ${ours.length} belong to the portal (${config.collectionPrefix}*)`);
  const others = cols.filter((c) => !c.startsWith(config.collectionPrefix));
  if (others.length) console.log('    other apps\' collections (left untouched):', others.join(', '));
  const counts = { users: await User.countDocuments(), heads: await User.countDocuments({ role: 'head' }), projects: await Project.countDocuments(), reports: await Report.countDocuments(), comments: await Comment.countDocuments(), notifications: await Notification.countDocuments() };
  ok('Portal data: ' + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', '));
  const hc = db.collection(config.collectionPrefix + 'healthcheck');
  const { insertedId } = await hc.insertOne({ at: new Date() });
  (await hc.findOne({ _id: insertedId })) ? ok('Write + read works') : bad('Could not read back test document');
  await hc.deleteOne({ _id: insertedId });
} catch (e) {
  bad('MongoDB connection failed: ' + e.message);
  console.log('    → Check MONGO_URI in Backend/.env and add your server IP in Atlas → Network Access.');
}
try {
  const h = await hashPassword('Test-Password-123');
  (await checkPassword('Test-Password-123', h)) && !(await checkPassword('wrong', h)) ? ok(`bcrypt hashing works (cost ${config.bcryptRounds})`) : bad('bcrypt check failed');
  const t = jwt.sign({ sub: 'x', role: 'head', tv: 0 }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '1m', issuer: config.jwtIssuer, audience: config.jwtAudience });
  jwt.verify(t, config.jwtSecret, { algorithms: ['HS256'], issuer: config.jwtIssuer, audience: config.jwtAudience });
  ok(`JWT sign/verify works (secret length ${config.jwtSecret.length}, expires ${config.jwtExpiresIn})`);
  try { jwt.verify(t, 'wrong-secret-wrong-secret-wrong-secret'); bad('JWT accepted a wrong secret!'); } catch { ok('JWT rejects tokens signed with another key'); }
} catch (e) { bad('Auth check failed: ' + e.message); }
await mongoose.disconnect();
console.log(process.exitCode ? '\nSome checks FAILED.\n' : '\nAll checks passed.\n');
