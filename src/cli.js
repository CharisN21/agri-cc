// Command line entry point: migrate, seed, reset.
import fs from 'node:fs';
import { config } from './config.js';
import { migrate, closeDb } from './db.js';

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'migrate': {
      console.log('Migrating...');
      migrate();
      break;
    }
    case 'seed': {
      console.log('Seeding...');
      const { seed, seedPayments, applySeedPassword } = await import('./seed.js');
      const { seedV2 } = await import('./seed-v2.js');
      seed();
      await seedPayments();
      seedV2();
      // Runs whether or not seed() did anything, so changing SEED_PASSWORD on a
      // host that kept its database file still takes effect.
      applySeedPassword();
      break;
    }
    case 'reset': {
      closeDb();
      let removed = 0;
      for (const suffix of ['', '-wal', '-shm']) {
        const file = config.dbPath + suffix;
        if (fs.existsSync(file)) { fs.rmSync(file); removed += 1; }
      }
      console.log(removed ? `Removed ${removed} database file(s).` : 'Nothing to remove.');
      break;
    }
    default:
      console.error('Usage: node src/cli.js <migrate|seed|reset>');
      process.exitCode = 1;
  }
  closeDb();
}

await main();
