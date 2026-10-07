// AUTH-1: shared session auth for /mobile and /configure.
// The session cookie is `air_sid` (Path=/), replacing the old `mobile_sid` (Path=/mobile).
// Legacy `mobile_sid` cookies are upgraded in place on first use.
const auth = require('../mobile/server/auth');

const COOKIE = 'air_sid';
const LEGACY_COOKIE = 'mobile_sid';
// Secure cookies need HTTPS (production runs behind the Cloudflare Tunnel).
// MOBILE_INSECURE_COOKIE=1 drops Secure for bare-HTTP LAN testing only.
const secureCookies = process.env.MOBILE_INSECURE_COOKIE !== '1';

// Minimal cookie reader — avoids adding cookie-parser. Returns '' if absent.
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function setSessionCookie(res, token, maxAgeSec) {
  const attrs = [`${COOKIE}=${token}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secureCookies) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookies(res) {
  const base = (name, pathStr) => {
    const attrs = [`${name}=`, 'HttpOnly', `Path=${pathStr}`, 'SameSite=Lax', 'Max-Age=0'];
    if (secureCookies) attrs.push('Secure');
    return attrs.join('; ');
  };
  res.append('Set-Cookie', base(COOKIE, '/'));
  res.append('Set-Cookie', base(LEGACY_COOKIE, '/mobile'));
}

// Resolve a session from the request. Reads air_sid first; if absent or no
// longer valid, tries legacy mobile_sid and upgrades it (sets air_sid, clears
// mobile_sid). Returns { profile, token, expiresAt } or null.
function sessionFromRequest(req, res) {
  let token = readCookie(req, COOKIE);
  let upgraded = false;
  if (token) {
    const detail = auth.resolveSessionDetail(token);
    if (detail) return { profile: detail.profile, token, expiresAt: detail.expiresAt };
    // air_sid present but invalid — fall through to legacy mobile_sid.
    token = readCookie(req, LEGACY_COOKIE);
    if (token) upgraded = true; else return null;
  } else {
    token = readCookie(req, LEGACY_COOKIE);
    if (token) upgraded = true; else return null;
  }
  const detail = auth.resolveSessionDetail(token);
  if (!detail) return null;
  if (upgraded) {
    setSessionCookie(res, token, Math.floor((detail.expiresAt - Date.now()) / 1000));
    const attrs = [`${LEGACY_COOKIE}=`, 'HttpOnly', 'Path=/mobile', 'SameSite=Lax', 'Max-Age=0'];
    if (secureCookies) attrs.push('Secure');
    res.append('Set-Cookie', attrs.join('; '));
  }
  return { profile: detail.profile, token, expiresAt: detail.expiresAt };
}

// Guard for /api/* (JSON API): 401 {error, auth:'signin'} or 403 {error, auth:'forbidden'}.
function requireAdminApi(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const session = sessionFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Not signed in', auth: 'signin' });
  if (session.profile.is_admin !== true) return res.status(403).json({ error: 'Admins only', auth: 'forbidden' });
  req.account = session.profile;
  req.sessionToken = session.token;
  next();
}

// Guard for /configure/ (HTML pages): 302 → /mobile/?next=%2Fconfigure%2F.
function requireAdminPage(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const session = sessionFromRequest(req, res);
  if (!session || session.profile.is_admin !== true) {
    return res.redirect('/mobile/?next=%2Fconfigure%2F');
  }
  req.account = session.profile;
  req.sessionToken = session.token;
  next();
}

module.exports = {
  COOKIE, LEGACY_COOKIE,
  readCookie, setSessionCookie, clearSessionCookies,
  sessionFromRequest, requireAdminApi, requireAdminPage,
};
