import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initDb } from './src/db.js';
import { migrate } from './src/migrate.js';
import { attachUser, requireAdmin } from './src/auth.js';
import { chatRouter, chatErrorHandler } from './src/routes/chat.js';
import { adminRouter } from './src/routes/admin.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');

await initDb();
await migrate();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// Public shell: GET / must answer 200 for the xhostd health check; the page itself checks sign-in.
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/admin.html', (_req, res) => res.redirect('/admin')); // only through the admin-checked route
app.use(express.static(publicDir, { index: false }));
app.get('/vendor/marked.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/marked/lib/marked.esm.js')));
app.get('/vendor/purify.js', (_req, res) => res.sendFile(path.join(root, 'node_modules/dompurify/dist/purify.es.mjs')));

app.use('/api', attachUser);
app.use('/api/admin', adminRouter);
app.use('/api', chatRouter);
app.get('/admin', attachUser, (req, res) => {
  if (!req.identity) return res.redirect('/');
  requireAdmin(req, res, () => res.sendFile(path.join(publicDir, 'admin.html')));
});
app.use(chatErrorHandler);

const port = Number(process.env.XHOST_HTTP_PORT || process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`[http] listening on ${port}`));
