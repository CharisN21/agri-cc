// Configuration. Reads .env by hand so the app keeps its three-dependency diet.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotenv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotenv();

export const config = {
  port: Number(process.env.PORT || 3000),
  dbPath: path.resolve(ROOT, process.env.DB_PATH || './data/agri.db'),
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  exportDir: path.join(ROOT, 'exports'),
  brand: 'SUN',
  // Render's free tier has no background workers, so the outbox is drained on a
  // timer inside the web process instead of by a separate service.
  workerInProcess: process.env.WORKER_IN_PROCESS === 'true',
  // Seeded demo accounts. Defaults to "<username>123"; override on a public
  // deployment so the documented passwords are not the live ones.
  seedPassword: process.env.SEED_PASSWORD || '',
  supabase: {
    url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    get enabled() { return Boolean(this.url && this.serviceKey); },
  },
};
