import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// All secrets come from environment variables (.env locally, host settings in production).
// Nothing secret is hard-coded here.
function required(name, check = (v) => !!v, hint = '') {
  const v = process.env[name];
  if (!check(v)) {
    console.error(`\n[config] Missing or invalid ${name}. ${hint}\nSet it in Backend/.env (see .env.example).\n`);
    process.exit(1);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT || 5000),
  mongoUri: required('MONGO_URI', (v) => /^mongodb(\+srv)?:\/\//.test(v || ''), 'It must be a MongoDB connection string.'),
  mongoDbName: process.env.MONGO_DB_NAME || undefined, // default: database named in MONGO_URI
  collectionPrefix: process.env.COLLECTION_PREFIX || 'ep_',
  jwtSecret: required('JWT_SECRET', (v) => (v || '').length >= 32, 'Use at least 32 random characters (npm run gen:secret).'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  jwtIssuer: 'tesco-execution-portal',
  jwtAudience: 'tesco-execution-portal-web',
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  tz: process.env.TZ_NAME || 'Asia/Kolkata',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  isProd: process.env.NODE_ENV === 'production',
};

export const ROLES = { HEAD: 'head', ENGINEER: 'engineer' }; // Admin = Execution Head, Team Member = Engineer
export const PROJECT_STATUSES = ['Not Started', 'Work In Progress', 'On Hold', 'Material Pending', 'Completed', 'Delayed'];
export const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
export const MATERIAL_STATUSES = ['Required', 'Ordered', 'Delivered'];
