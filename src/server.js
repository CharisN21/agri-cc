// HTTP entry point. Server-rendered EJS, no build step, no client framework.
import path from 'node:path';
import express from 'express';
import { config, ROOT } from './config.js';
import { migrate } from './db.js';
import { attachUser } from './auth.js';
import { attachContext, weight } from './context.js';
import { money, kg, pct, fromBp, fromCents, fromGrams } from './domain/units.js';
import mountRoutes from './routes/index.js';
import { isMain } from './is-main.js';

export function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'src', 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(path.join(ROOT, 'public')));

  // Formatting helpers available in every template. Conversion from integer
  // storage units to human decimals happens HERE and nowhere earlier.
  app.locals.money = money;
  app.locals.kg = kg;
  app.locals.pct = pct;
  app.locals.fromBp = fromBp;
  app.locals.fromCents = fromCents;
  app.locals.fromGrams = fromGrams;
  app.locals.tonnes = (g) => (g / 1_000_000).toFixed(3);
  // Weight in whichever unit this viewer chose. Storage is always grams; only
  // the reading changes.
  app.locals.weight = weight;
  app.locals.brand = config.brand;
  // The login page only advertises the documented demo passwords when they are
  // actually in force. A deployment that sets SEED_PASSWORD must not print it.
  app.locals.showDemoHints = !config.seedPassword;

  app.use(attachUser);
  app.use(attachContext);
  mountRoutes(app);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(400).render('error', {
      title: 'Something went wrong',
      status: 400,
      message: err.message,
    });
  });

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Not found', status: 404, message: `No page at ${req.path}`,
    });
  });

  return app;
}

/**
 * Drain the payment outbox from inside the web process.
 *
 * This exists only because Render's free tier has no background workers. It is
 * the same drainOutbox() the standalone worker calls, so behaviour is identical
 * — including the idempotency key that makes a double drain harmless. On any
 * plan with workers, leave WORKER_IN_PROCESS unset and run `npm run worker`
 * as its own service instead.
 */
function startInProcessWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;             // never overlap with the previous run
    running = true;
    try {
      const { drainOutbox } = await import('./payments/worker.js');
      const r = await drainOutbox();
      if (r.paid || r.failed) {
        console.log(`outbox: paid ${r.paid}, duplicate ${r.duplicate}, failed ${r.failed}`);
      }
    } catch (err) {
      console.error('outbox drain failed:', err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 15000);
  timer.unref();                     // never hold the process open
  tick();
  console.log('outbox worker running in-process every 15s');
}

if (isMain(import.meta.url)) {
  migrate({ log: () => {} });
  const app = createApp();
  // 0.0.0.0 so the container's port is reachable on hosts like Render.
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`agri-cc listening on http://localhost:${config.port}`);
    console.log(config.seedPassword
      ? 'Demo accounts use SEED_PASSWORD from the environment.'
      : 'Sign in as owner/owner123, finance/finance123, clerk/clerk123');
    if (config.workerInProcess) startInProcessWorker();
  });
}
