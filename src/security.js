// HTTP hardening: security headers, cross-site write blocking, and simple per-user rate limits.

const csv = (value) => (value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

// Everything the pages load is same-origin: module scripts, stylesheets, the self-hosted font, /icon.svg
// and fetch() to /api. Inline styles are set through CSSOM (el.style), which CSP does not restrict.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "media-src 'self'", // the demo video on the sign-in screen
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export function securityHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

function allowedHosts(req) {
  const configured = csv(process.env.XHOST_AUTH_AUDIENCES);
  return configured.length ? configured : [String(req.get('host') ?? '').toLowerCase()];
}

// xhostd.app is not on the Public Suffix List, so apps of other tenants on *.xhostd.app are "same-site"
// and SameSite=Lax cookies do not stop them from posting here. Refuse state-changing requests that the
// browser marks as cross-origin (Sec-Fetch-Site) or that carry a foreign Origin.
export function blockCrossSiteWrites(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const refuse = () => res.status(403).json({ error: 'cross_site_request' });
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return refuse();
  const origin = req.get('origin');
  if (origin) {
    let host;
    try { host = new URL(origin).host.toLowerCase(); } catch { return refuse(); }
    if (!allowedHosts(req).includes(host)) return refuse();
  }
  next();
}

// Sliding-window limiter kept in memory (single instance). Keyed by user when signed in.
const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of hits) if (now - entry.at > entry.windowMs) hits.delete(key);
}, 60_000).unref();

export function rateLimit({ name, limit, windowMs }) {
  return (req, res, next) => {
    const key = `${name}:${req.account?.id ?? req.ip}`;
    const now = Date.now();
    const entry = hits.get(key) ?? { times: [], windowMs, at: now };
    entry.times = entry.times.filter((t) => now - t < windowMs);
    entry.at = now;
    if (entry.times.length >= limit) {
      res.setHeader('Retry-After', String(Math.ceil((windowMs - (now - entry.times[0])) / 1000)));
      return res.status(429).json({ error: 'rate_limited', message: 'בוצעו יותר מדי בקשות בזמן קצר. נסו שוב בעוד מספר דקות.' });
    }
    entry.times.push(now);
    hits.set(key, entry);
    next();
  };
}
