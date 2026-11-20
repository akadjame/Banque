const crypto = require('node:crypto');
const { db } = require('./db');
const config = require('./config');

// ---------- Mots de passe (scrypt) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Le mot de passe doit contenir au moins 10 caractères.';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw)) return 'Le mot de passe doit contenir une minuscule, une majuscule et un chiffre.';
  return null;
}

// ---------- Sessions ----------
const COOKIE = 'sid';

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function cookieAttrs(maxAgeSec) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${config.production ? '; Secure' : ''}`;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  const maxAge = config.sessionDays * 86400;
  db.prepare('INSERT INTO sessions (token,user_id,csrf,expires_at) VALUES (?,?,?,?)').run(token, userId, csrf, Date.now() + maxAge * 1000);
  res.append('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(maxAge)}`);
}

function destroySession(req, res) {
  if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
  res.append('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`);
}

// Session anonyme : on garde un jeton CSRF dans un cookie séparé pour les formulaires publics
function sessionMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  req.user = null;
  const token = cookies[COOKIE];
  if (token) {
    const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (s && s.expires_at > Date.now()) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
      if (u && u.status !== 'bloque' && u.status !== 'cloture') {
        req.user = u;
        req.sessionToken = token;
        req.csrfToken = s.csrf;
      }
    } else if (s) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    }
  }
  if (!req.csrfToken) {
    let anon = cookies.acsrf;
    if (!anon || !/^[a-f0-9]{48}$/.test(anon)) {
      anon = crypto.randomBytes(24).toString('hex');
      res.append('Set-Cookie', `acsrf=${anon}; ${cookieAttrs(86400)}`);
    }
    req.csrfToken = anon;
  }
  res.locals.user = req.user;
  res.locals.csrf = req.csrfToken;
  next();
}

function csrfCheck(req, res, next) {
  if (req.method !== 'POST') return next();
  const sent = (req.body && req.body._csrf) || '';
  const ok = sent.length === req.csrfToken.length &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.csrfToken));
  if (!ok) return res.status(403).render('error', { title: 'Session expirée', message: 'Votre session a expiré. Merci de recharger la page et de réessayer.' });
  next();
}

function requireClient(req, res, next) {
  if (!req.user) return res.redirect('/connexion?next=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'client') return res.redirect('/admin');
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/connexion?next=' + encodeURIComponent(req.originalUrl));
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Accès refusé', message: "Cette page est réservée à l'administration." });
  next();
}

// Limitation simple des tentatives de connexion (en mémoire)
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(key, a);
  return a.length >= 8;
}
function recordFailure(key) {
  const a = attempts.get(key) || [];
  a.push(Date.now());
  attempts.set(key, a);
}
function clearFailures(key) { attempts.delete(key); }

module.exports = {
  hashPassword, verifyPassword, passwordProblem,
  createSession, destroySession, sessionMiddleware, csrfCheck,
  requireClient, requireAdmin, tooManyAttempts, recordFailure, clearFailures,
};
