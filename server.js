import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initDb } from './src/db.js';
import { repriceUnpricedUsage } from './src/usage.js';
import { migrate } from './src/migrate.js';
import { assertAuthConfig, attachUser, requireAdmin } from './src/auth.js';
import { blockCrossSiteWrites, securityHeaders } from './src/security.js';
import { chatRouter, chatErrorHandler, drainActiveTurns } from './src/routes/chat.js';
import { adminRouter } from './src/routes/admin.js';
import { runSelfCheck } from './src/selfcheck.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const viewsDir = path.join(root, 'views');

assertAuthConfig();
await initDb();
await migrate();
// Calls logged before their model had a price get their cost now (see usage.js).
repriceUnpricedUsage().then((r) => { if (r.repriced) console.log(`[usage] repriced ${r.repriced} of ${r.unpriced} unpriced model calls`); }).catch((err) => console.error('[usage] repricing failed', err));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));

// Public shell: GET / must answer 200 for the xhostd health check; the page itself checks sign-in.
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/accessibility', (_req, res) => res.sendFile(path.join(publicDir, 'accessibility.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(publicDir, 'privacy.html')));
app.use(express.static(publicDir, { index: false }));
app.get('/vendor/marked.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/marked/lib/marked.esm.js')));
app.get('/vendor/purify.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/dompurify/dist/purify.es.mjs')));
// Self-hosted font: no third-party request (and no visitor IP sent to Google).
app.use('/vendor/heebo', express.static(path.join(root, 'node_modules/@fontsource-variable/heebo'), { maxAge: '30d' }));
if (process.env.NODE_ENV !== 'production') {
  // Accessibility testing aid (axe-core is a dev dependency and absent in production installs).
  app.get('/vendor/axe.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/axe-core/axe.min.js')));
}

app.use('/api', blockCrossSiteWrites);
app.use('/api', attachUser);
app.use('/api/admin', adminRouter);
app.use('/api', chatRouter);
// The admin page lives outside public/, so the admin check below is the only way to reach it.
app.get('/admin', attachUser, (req, res) => {
  if (!req.identity) return res.redirect('/');
  requireAdmin(req, res, () => res.sendFile(path.join(viewsDir, 'admin.html')));
});
app.use(chatErrorHandler);

const port = Number(process.env.XHOST_HTTP_PORT || process.env.PORT || 3000);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`[http] listening on ${port} (node ${process.version})`);
  // Runs after listen so it never delays the health check.
  if (process.env.SELFCHECK !== 'off') runSelfCheck().catch((err) => console.error('[selfcheck] failed', err));
});

// A deploy stops this container: give running turns a few seconds, then record the rest as interrupted.
let shuttingDown = false;
process.on('SIGTERM', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[http] SIGTERM received, draining active turns');
  server.close();
  const interrupted = await drainActiveTurns(8000);
  console.log(`[http] exiting, interrupted turns: ${interrupted}`);
  process.exit(0);
});
