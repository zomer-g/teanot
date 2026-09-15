// xhostd built-in SSO: the platform sets an RS256 JWT in the __Host-xhost_id cookie.
// Signing in only proves identity; access is decided here (users table + ADMIN_EMAILS).
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { query } from './db.js';

const ISSUER = 'https://auth.xhostd.com';
const COOKIE = '__Host-xhost_id';
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/xhost-auth/jwks`));

const csv = (value) => (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const adminEmails = () => csv(process.env.ADMIN_EMAILS);
const inProduction = () => process.env.NODE_ENV === 'production';

export const loginUrl = (returnTo = '/') => `/xhost-auth/login?return_to=${encodeURIComponent(returnTo)}`;
export const logoutUrl = '/xhost-auth/logout?return_to=/';

// Tokens of every xhostd app come from the same issuer, so the audience is what binds a token to this
// app. Production must name its hostnames explicitly; the Host header is client-controlled.
export function assertAuthConfig() {
  if (inProduction() && !csv(process.env.XHOST_AUTH_AUDIENCES).length) {
    throw new Error('XHOST_AUTH_AUDIENCES must list this app\'s hostnames in production');
  }
}

// Local development only: never on xhostd (XHOST_HTTP_PORT) or against a real database.
function devBypassEmail() {
  const email = process.env.DEV_AUTH_EMAIL;
  if (!email || inProduction() || process.env.XHOST_HTTP_PORT || process.env.DATABASE_URL) return null;
  return email.toLowerCase();
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return null;
    }
  }
  return null;
}

async function identify(req) {
  const devEmail = devBypassEmail();
  if (devEmail) return { sub: `dev:${devEmail}`, email: devEmail, name: 'Dev User' };

  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const configured = csv(process.env.XHOST_AUTH_AUDIENCES);
  const audience = configured.length ? configured : (inProduction() ? null : req.get('host'));
  if (!audience) return null;
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: ISSUER,
      audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iss', 'aud', 'sub', 'email'],
      clockTolerance: 60,
    });
    if (payload.email_verified === false) return null;
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
  if (row) {
    const { sub, stale, ...account } = row;
    // An account is bound to the first identity (sub) that signed in with its email. A different identity
    // presenting the same email is refused rather than silently taking the account over.
    if (sub && sub !== identity.sub) {
      console.warn(`[auth] identity mismatch for account ${account.id}; access refused`);
      return { ...account, status: 'blocked' };
    }
    const upToDate = !stale && sub === identity.sub && (!isAdmin || (account.role === 'admin' && account.status === 'active'));
    if (upToDate) return account;
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
     RETURNING ${ACCOUNT_COLUMNS}`,
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
