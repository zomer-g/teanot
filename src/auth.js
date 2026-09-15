// xhostd built-in SSO: the platform sets an RS256 JWT in the __Host-xhost_id cookie.
// Signing in only proves identity; access is decided here (users table + ADMIN_EMAILS).
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query } from './db.js';

const ISSUER = 'https://auth.xhostd.com';
const COOKIE = '__Host-xhost_id';
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/xhost-auth/jwks`));

const csv = (value) => (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const adminEmails = () => csv(process.env.ADMIN_EMAILS);

export const loginUrl = (returnTo = '/') => `/xhost-auth/login?return_to=${encodeURIComponent(returnTo)}`;
export const logoutUrl = '/xhost-auth/logout?return_to=/';

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

async function identify(req) {
  const devEmail = process.env.DEV_AUTH_EMAIL;
  if (devEmail && process.env.NODE_ENV !== 'production') {
    return { sub: `dev:${devEmail}`, email: devEmail.toLowerCase(), name: 'Dev User' };
  }
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  // A configured audience list is preferred: the Host header is client-controlled.
  const audiences = csv(process.env.XHOST_AUTH_AUDIENCES);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience: audiences.length ? audiences : req.get('host'),
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iss', 'aud', 'sub', 'email'],
      clockTolerance: 60,
    });
    return {
      sub: String(payload.sub),
      email: String(payload.email).toLowerCase(),
      name: payload.name ? String(payload.name) : null,
    };
  } catch {
    return null;
  }
}

const ACCOUNT_COLUMNS = 'id, email, name, role, status, token_limit, limit_period';

// Loads the signed-in person. Unknown people are recorded as "pending" so the admin can approve them.
// Reads first and writes only when something changed, so ordinary requests don't touch the users table.
async function loadAccount(identity) {
  const isAdmin = adminEmails().includes(identity.email);
  const existing = await query(
    `SELECT ${ACCOUNT_COLUMNS}, sub, last_seen_at < now() - interval '5 minutes' AS stale FROM users WHERE email = $1`,
    [identity.email],
  );
  const row = existing.rows[0];
  const upToDate = row && !row.stale && row.sub === identity.sub
    && (!isAdmin || (row.role === 'admin' && row.status === 'active'));
  if (upToDate) {
    const { sub, stale, ...account } = row;
    return account;
  }
  const { rows } = await query(
    `INSERT INTO users (email, sub, name, role, status, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (email) DO UPDATE SET
       sub = EXCLUDED.sub,
       name = COALESCE(EXCLUDED.name, users.name),
       role = CASE WHEN $6::boolean THEN 'admin' ELSE users.role END,
       status = CASE WHEN $6::boolean THEN 'active' ELSE users.status END,
       last_seen_at = now()
     RETURNING id, email, name, role, status, token_limit, limit_period`,
    [identity.email, identity.sub, identity.name, isAdmin ? 'admin' : 'user', isAdmin ? 'active' : 'pending', isAdmin],
  );
  return rows[0];
}

export async function attachUser(req, _res, next) {
  req.identity = await identify(req);
  req.account = req.identity ? await loadAccount(req.identity) : null;
  next();
}

export function requireActive(req, res, next) {
  if (!req.identity) {
    return res.status(401).json({ error: 'unauthenticated', loginUrl: loginUrl('/') });
  }
  if (req.account.status !== 'active') {
    return res.status(403).json({ error: 'not_authorized', status: req.account.status });
  }
  next();
}

export function requireAdmin(req, res, next) {
  requireActive(req, res, () => {
    if (req.account.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
    next();
  });
}
