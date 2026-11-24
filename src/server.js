const path = require('node:path');
const express = require('express');
const config = require('./config');
const { db, getSetting } = require('./db');
const auth = require('./auth');
const m = require('./money');
const bank = require('./bank');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; form-action 'self'; frame-ancestors 'none'");
  next();
});
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: config.production ? '7d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(auth.sessionMiddleware);

// Messages flash (cookie court)
app.use((req, res, next) => {
  const raw = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith('flash='));
  res.locals.flash = null;
  if (raw) {
    try { res.locals.flash = JSON.parse(Buffer.from(raw.slice(6), 'base64url').toString()); } catch { /* ignore */ }
    res.append('Set-Cookie', 'flash=; Path=/; Max-Age=0');
  }
  req.flash = (type, text) => res.append('Set-Cookie', `flash=${Buffer.from(JSON.stringify({ type, text })).toString('base64url')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=60`);
  next();
});

app.use(auth.csrfCheck);

// Helpers disponibles dans toutes les vues
app.locals.bank = config.bank;
app.locals.eur = m.formatEuros;
app.locals.iban = m.formatIban;
app.locals.rate = m.formatRate;
app.locals.date = (d) => (d ? m.parseDbDate(d).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) : '—');
app.locals.datetime = (d) => (d ? m.parseDbDate(d).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }) : '—');
// Description courte du taux d'un produit
app.locals.productRateText = (p) => p.kind === 'cat'
  ? `taux fixe garanti ${p.term_months} mois`
  : p.boosted_rate ? `pendant ${p.boost_months} mois, puis ${m.formatRate(p.base_rate)}` : 'taux annuel brut';
app.locals.headlineRate = (p) => p.boosted_rate || p.base_rate;
app.locals.txLabels = { depot: 'Versement', retrait: 'Retrait', interets: 'Intérêts', prime: 'Prime', parrainage: 'Parrainage', ajustement: 'Régularisation' };
app.locals.statusLabels = { en_attente: 'En attente', actif: 'Actif', bloque: 'Bloqué', cloture: 'Clôturé', effectue: 'Effectué', refuse: 'Refusé', annule: 'Annulé' };

function offer() {
  const boost = db.prepare("SELECT * FROM products WHERE active = 1 AND boosted_rate IS NOT NULL ORDER BY boosted_rate DESC LIMIT 1").get();
  return {
    boost,
    products: bank.listProducts(),
    welcome: Number(getSetting('welcome_bonus_cents')),
    referrer: Number(getSetting('referrer_bonus_cents')),
    referee: Number(getSetting('referee_bonus_cents')),
    endDate: getSetting('offer_end_date'),
  };
}
app.use((req, res, next) => { res.locals.offer = offer(); res.locals.path = req.path; next(); });

// Petite aide pour attraper les erreurs métier et revenir au formulaire
const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res, next); } catch (e) {
    if (e instanceof bank.BankError) { req.flash('error', e.message); return res.redirect(req.get('Referer') || '/'); }
    next(e);
  }
};
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

// ======================= SITE PUBLIC =======================
app.get('/', (req, res) => res.render('index', { title: 'Épargne en ligne' }));
app.get('/aide', (req, res) => res.render('aide', { title: 'Aide & FAQ' }));
app.get('/mentions-legales', (req, res) => res.render('mentions', { title: 'Mentions légales' }));

app.get('/ouvrir-un-livret', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/espace/ouvrir');
  res.render('ouvrir', { title: 'Ouvrir un livret', values: { parrain: str(req.query.parrain, 20) }, error: null });
});

app.post('/ouvrir-un-livret', (req, res) => {
  const b = req.body;
  const values = {
    civility: str(b.civility, 5), first_name: str(b.first_name, 60), last_name: str(b.last_name, 60), email: str(b.email, 120).toLowerCase(),
    birth_date: str(b.birth_date, 10), phone: str(b.phone, 20), address: str(b.address, 160), postal_code: str(b.postal_code, 10),
    city: str(b.city, 80), reference_iban: m.normalizeIban(b.reference_iban), reference_holder: str(b.reference_holder, 120),
    product_id: Number(b.product_id), parrain: str(b.parrain, 20).toUpperCase(),
  };
  const fail = (error) => res.status(400).render('ouvrir', { title: 'Ouvrir un livret', values, error });

  if (!values.first_name || !values.last_name) return fail('Nom et prénom obligatoires.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) return fail('Adresse e-mail invalide.');
  const birth = new Date(values.birth_date);
  if (isNaN(birth) || (Date.now() - birth) / (365.25 * 86400000) < 18) return fail('Vous devez être majeur pour ouvrir un livret en ligne.');
  if (!values.address || !values.postal_code || !values.city) return fail('Adresse complète obligatoire.');
  if (!m.isValidIban(values.reference_iban)) return fail('IBAN du compte de référence invalide.');
  if (!bank.getProduct(values.product_id)) return fail('Choisissez un livret.');
  const pwProblem = auth.passwordProblem(b.password);
  if (pwProblem) return fail(pwProblem);
  if (b.password !== b.password2) return fail('Les deux mots de passe ne correspondent pas.');
  if (!b.cgu) return fail('Vous devez accepter les conditions générales.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) return fail('Un compte existe déjà avec cette adresse e-mail.');

  let referredBy = null;
  if (values.parrain) {
    const p = db.prepare("SELECT id FROM users WHERE referral_code = ? AND role = 'client'").get(values.parrain);
    if (!p) return fail('Code parrain inconnu.');
    referredBy = p.id;
  }
  const userId = bank.createUser({ ...values, password_hash: auth.hashPassword(b.password), referred_by: referredBy });
  auth.createSession(res, userId);
  req.flash('success', 'Votre demande d’ouverture est enregistrée. Votre dossier est en cours de validation.');
  res.redirect('/espace');
});

app.get('/connexion', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/espace');
  res.render('connexion', { title: 'Connexion', error: null, email: '', next: str(req.query.next, 200) });
});

app.post('/connexion', (req, res) => {
  const email = str(req.body.email, 120).toLowerCase();
  const next = str(req.body.next, 200);
  const key = `${req.ip}|${email}`;
  const fail = (error) => res.status(401).render('connexion', { title: 'Connexion', error, email, next });
  if (auth.tooManyAttempts(key)) return fail('Trop de tentatives. Réessayez dans 15 minutes.');
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !auth.verifyPassword(String(req.body.password || ''), u.password_hash)) {
    auth.recordFailure(key);
    return fail('Identifiant ou mot de passe incorrect.');
  }
  if (u.status === 'bloque' || u.status === 'cloture') return fail('Votre accès est suspendu. Contactez le service client.');
  auth.clearFailures(key);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(u.id);
  auth.createSession(res, u.id);
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : null;
  res.redirect(safeNext || (u.role === 'admin' ? '/admin' : '/espace'));
});

app.post('/deconnexion', (req, res) => { auth.destroySession(req, res); res.redirect('/'); });

// ======================= ESPACE CLIENT =======================
const espace = express.Router();
espace.use(auth.requireClient);
espace.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.unread = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND from_admin = 1 AND read_at IS NULL').get(req.user.id).n;
  next();
});

function ownAccount(req) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!acc) throw new bank.BankError('Compte introuvable.');
  return bank.accountView(acc);
}

espace.get('/', (req, res) => {
  const accounts = bank.userAccounts(req.user.id);
  const ids = accounts.map((a) => a.id);
  const recent = ids.length ? db.prepare(`SELECT t.*, p.name AS product_name FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN products p ON p.id = a.product_id
    WHERE a.user_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT 8`).all(req.user.id) : [];
  const total = accounts.reduce((s, a) => s + a.balance_cents, 0);
  const totalAccrued = accounts.reduce((s, a) => s + a.accrued.cents, 0);
  const interestYear = db.prepare(`SELECT COALESCE(SUM(t.amount_cents),0) AS s FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.user_id = ? AND t.type = 'interets' AND strftime('%Y', t.created_at) = strftime('%Y','now')`).get(req.user.id).s;
  res.render('client/dashboard', { title: 'Mon espace', accounts, recent, total, totalAccrued, interestYear, goals: bank.userGoals(req.user.id) });
});

espace.get('/compte/:id', handle((req, res) => {
  const account = ownAccount(req);
  const type = str(req.query.type, 20);
  const page = Math.max(1, Number(req.query.page) || 1);
  const where = type && app.locals.txLabels[type] ? 'AND type = ?' : '';
  const params = where ? [account.id, type] : [account.id];
  const count = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? ${where}`).get(...params).n;
  const txs = db.prepare(`SELECT * FROM transactions WHERE account_id = ? ${where} ORDER BY created_at DESC, id DESC LIMIT 25 OFFSET ?`).all(...params, (page - 1) * 25);
  const months = db.prepare("SELECT DISTINCT strftime('%Y-%m', created_at) AS m FROM transactions WHERE account_id = ? ORDER BY m DESC").all(account.id).map((r) => r.m);
  res.render('client/compte', { title: account.product.name, account, txs, type, page, pages: Math.max(1, Math.ceil(count / 25)), months });
}));

espace.get('/compte/:id/rib', handle((req, res) => {
  res.render('client/rib', { title: 'RIB', account: ownAccount(req) });
}));

espace.get('/compte/:id/releve', handle((req, res) => {
  const account = ownAccount(req);
  const month = /^\d{4}-\d{2}$/.test(req.query.mois) ? req.query.mois : new Date().toISOString().slice(0, 7);
  const txs = db.prepare("SELECT * FROM transactions WHERE account_id = ? AND strftime('%Y-%m', created_at) = ? ORDER BY created_at, id").all(account.id, month);
  const before = db.prepare("SELECT balance_after_cents FROM transactions WHERE account_id = ? AND strftime('%Y-%m', created_at) < ? ORDER BY created_at DESC, id DESC LIMIT 1").get(account.id, month);
  const opening = before ? before.balance_after_cents : 0;
  const closing = txs.length ? txs[txs.length - 1].balance_after_cents : opening;
  res.render('client/releve', { title: 'Relevé', account, txs, month, opening, closing });
}));

espace.get('/retrait', (req, res) => {
  const accounts = bank.userAccounts(req.user.id);
  const requests = db.prepare(`SELECT w.*, p.name AS product_name FROM withdrawals w JOIN accounts a ON a.id = w.account_id JOIN products p ON p.id = a.product_id
    WHERE a.user_id = ? ORDER BY w.created_at DESC LIMIT 30`).all(req.user.id);
  res.render('client/retrait', { title: 'Retrait', accounts, requests });
});

espace.post('/retrait', handle((req, res) => {
  if (req.user.status !== 'actif') throw new bank.BankError('Votre dossier doit être validé avant toute demande de retrait.');
  const amount = m.parseEuros(req.body.amount);
  bank.requestWithdrawal(req.user, Number(req.body.account_id), amount, str(req.body.note, 140));
  req.flash('success', `Demande de retrait de ${m.formatEuros(amount)} enregistrée. Le virement sera émis vers votre compte de référence sous 24 à 48 h ouvrées.`);
  res.redirect('/espace/retrait');
}));

espace.post('/retrait/:id/annuler', handle((req, res) => {
  bank.cancelWithdrawal(req.user, Number(req.params.id));
  req.flash('success', 'Demande de retrait annulée.');
  res.redirect('/espace/retrait');
}));

espace.get('/versement', (req, res) => {
  res.render('client/versement', { title: 'Alimenter mon livret', accounts: bank.userAccounts(req.user.id) });
});

espace.get('/ouvrir', (req, res) => {
  const owned = db.prepare("SELECT product_id FROM accounts WHERE user_id = ? AND status != 'cloture'").all(req.user.id).map((r) => r.product_id);
  res.render('client/ouvrir', { title: 'Ouvrir un livret', products: bank.listProducts().filter((p) => !owned.includes(p.id)) });
});
espace.post('/ouvrir', handle((req, res) => {
  const pid = Number(req.body.product_id);
  if (db.prepare("SELECT 1 FROM accounts WHERE user_id = ? AND product_id = ? AND status != 'cloture'").get(req.user.id, pid)) throw new bank.BankError('Vous détenez déjà ce livret.');
  bank.openAccount(req.user.id, pid);
  req.flash('success', 'Votre nouveau produit d’épargne est ouvert.');
  res.redirect('/espace');
}));

espace.get('/profil', (req, res) => res.render('client/profil', { title: 'Mon profil' }));
espace.post('/profil', handle((req, res) => {
  const b = req.body;
  if (b.action === 'coordonnees') {
    db.prepare('UPDATE users SET phone = ?, address = ?, postal_code = ?, city = ? WHERE id = ?')
      .run(str(b.phone, 20), str(b.address, 160), str(b.postal_code, 10), str(b.city, 80), req.user.id);
    req.flash('success', 'Coordonnées mises à jour.');
  } else if (b.action === 'reference') {
    if (!auth.verifyPassword(String(b.password || ''), req.user.password_hash)) throw new bank.BankError('Mot de passe incorrect.');
    const ib = m.normalizeIban(b.reference_iban);
    if (!m.isValidIban(ib)) throw new bank.BankError('IBAN invalide.');
    if (db.prepare("SELECT 1 FROM withdrawals w JOIN accounts a ON a.id = w.account_id WHERE a.user_id = ? AND w.status = 'en_attente'").get(req.user.id)) {
      throw new bank.BankError('Impossible de modifier le compte de référence tant qu’un retrait est en attente.');
    }
    db.prepare('UPDATE users SET reference_iban = ?, reference_holder = ? WHERE id = ?').run(ib, str(b.reference_holder, 120), req.user.id);
    req.flash('success', 'Compte de référence mis à jour.');
  } else if (b.action === 'password') {
    if (!auth.verifyPassword(String(b.current || ''), req.user.password_hash)) throw new bank.BankError('Mot de passe actuel incorrect.');
    const p = auth.passwordProblem(b.password);
    if (p) throw new bank.BankError(p);
    if (b.password !== b.password2) throw new bank.BankError('Les deux mots de passe ne correspondent pas.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(b.password), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sessionToken);
    req.flash('success', 'Mot de passe modifié.');
  }
  res.redirect('/espace/profil');
}));

espace.get('/parrainage', (req, res) => {
  const filleuls = db.prepare('SELECT first_name, last_name, created_at, referral_paid, status FROM users WHERE referred_by = ? ORDER BY created_at DESC').all(req.user.id);
  res.render('client/parrainage', { title: 'Parrainage', filleuls, link: `${req.protocol}://${req.get('host')}/ouvrir-un-livret?parrain=${req.user.referral_code}` });
});

espace.get('/messages', (req, res) => {
  const msgs = db.prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY created_at, id').all(req.user.id);
  db.prepare("UPDATE messages SET read_at = datetime('now') WHERE user_id = ? AND from_admin = 1 AND read_at IS NULL").run(req.user.id);
  res.render('client/messages', { title: 'Messagerie', msgs });
});
espace.post('/messages', handle((req, res) => {
  const body = str(req.body.body, 3000);
  if (!body) throw new bank.BankError('Message vide.');
  db.prepare('INSERT INTO messages (user_id, from_admin, subject, body) VALUES (?,0,?,?)').run(req.user.id, str(req.body.subject, 120) || null, body);
  req.flash('success', 'Message envoyé à votre conseiller.');
  res.redirect('/espace/messages');
}));

// ----- Projets d'épargne -----
espace.get('/projets', (req, res) => {
  res.render('client/projets', { title: 'Mes projets', goals: bank.userGoals(req.user.id), accounts: bank.userAccounts(req.user.id) });
});
espace.post('/projets', handle((req, res) => {
  const name = str(req.body.name, 60);
  const target = m.parseEuros(req.body.target);
  if (!name) throw new bank.BankError('Donnez un nom à votre projet.');
  if (!target) throw new bank.BankError('Montant objectif invalide.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.target_date || '') ? req.body.target_date : null;
  let accountId = Number(req.body.account_id) || null;
  if (accountId && !db.prepare('SELECT 1 FROM accounts WHERE id = ? AND user_id = ?').get(accountId, req.user.id)) accountId = null;
  const emoji = ['🏠', '🚗', '✈️', '🎓', '💍', '👶', '🛟', '🎁'].includes(req.body.emoji) ? req.body.emoji : '🎯';
  db.prepare('INSERT INTO goals (user_id, account_id, name, emoji, target_cents, target_date) VALUES (?,?,?,?,?,?)').run(req.user.id, accountId, name, emoji, target, date);
  req.flash('success', `Projet « ${name} » créé.`);
  res.redirect('/espace/projets');
}));
espace.post('/projets/:id/supprimer', handle((req, res) => {
  db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  req.flash('success', 'Projet supprimé.');
  res.redirect('/espace/projets');
}));

// ----- Versements programmés -----
espace.get('/versements-programmes', (req, res) => {
  res.render('client/programmes', { title: 'Versements programmés', orders: bank.userStandingOrders(req.user.id),
    accounts: bank.userAccounts(req.user.id).filter((a) => a.status === 'actif' && a.product.kind !== 'cat') });
});
espace.post('/versements-programmes', handle((req, res) => {
  const amount = m.parseEuros(req.body.amount);
  const day = Number(req.body.day);
  const acc = db.prepare("SELECT a.* FROM accounts a JOIN products p ON p.id = a.product_id WHERE a.id = ? AND a.user_id = ? AND a.status = 'actif' AND p.kind != 'cat'").get(Number(req.body.account_id), req.user.id);
  if (!acc) throw new bank.BankError('Choisissez un livret.');
  if (!amount || amount < 1000) throw new bank.BankError('Montant minimum : 10 €.');
  if (!(day >= 1 && day <= 28)) throw new bank.BankError('Jour invalide (1 à 28).');
  db.prepare('INSERT INTO standing_orders (user_id, account_id, amount_cents, day_of_month) VALUES (?,?,?,?)').run(req.user.id, acc.id, amount, day);
  req.flash('success', `Versement programmé de ${m.formatEuros(amount)} le ${day} de chaque mois enregistré.`);
  res.redirect('/espace/versements-programmes');
}));
espace.post('/versements-programmes/:id/supprimer', handle((req, res) => {
  db.prepare('UPDATE standing_orders SET active = 0 WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  req.flash('success', 'Versement programmé arrêté.');
  res.redirect('/espace/versements-programmes');
}));

// ----- Documents -----
espace.get('/documents', (req, res) => {
  const accounts = bank.userAccounts(req.user.id);
  const months = db.prepare(`SELECT DISTINCT t.account_id, strftime('%Y-%m', t.created_at) AS m FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE a.user_id = ? ORDER BY m DESC`).all(req.user.id);
  const years = [...new Set(months.map((r) => r.m.slice(0, 4)))];
  res.render('client/documents', { title: 'Mes documents', accounts, months, years });
});
espace.get('/documents/fiscal/:year', handle((req, res) => {
  const year = Number(req.params.year);
  if (!(year >= 2000 && year <= 2100)) throw new bank.BankError('Année invalide.');
  const rows = bank.taxSummary(req.user.id, year);
  res.render('client/fiscal', { title: `Récapitulatif fiscal ${year}`, year, rows,
    total: rows.reduce((s, r) => s + r.interest, 0), totalBonus: rows.reduce((s, r) => s + r.bonuses, 0) });
}));

app.use('/espace', espace);

// ======================= ADMINISTRATION =======================
const admin = express.Router();
admin.use(auth.requireAdmin);
admin.use((req, res, next) => {
  res.locals.path = req.path;
  res.locals.counts = {
    pendingUsers: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='client' AND status='en_attente'").get().n,
    pendingWithdrawals: db.prepare("SELECT COUNT(*) AS n FROM withdrawals WHERE status='en_attente'").get().n,
    unread: db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM messages WHERE from_admin = 0 AND read_at IS NULL').get().n,
  };
  next();
});

admin.get('/', (req, res) => {
  const stats = {
    clients: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='client'").get().n,
    active: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='client' AND status='actif'").get().n,
    encours: db.prepare("SELECT COALESCE(SUM(balance_cents),0) AS s FROM accounts WHERE status != 'cloture'").get().s,
    accounts: db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE status != 'cloture'").get().n,
    interestMonth: db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE type='interets' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").get().s,
  };
  const accrued = db.prepare("SELECT * FROM accounts WHERE status != 'cloture'").all().reduce((s, a) => s + bank.accruedInterest(a).cents, 0);
  const recentUsers = db.prepare("SELECT * FROM users WHERE role='client' ORDER BY created_at DESC LIMIT 6").all();
  const recentTx = db.prepare(`SELECT t.*, u.first_name, u.last_name, u.id AS user_id FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN users u ON u.id = a.user_id
    ORDER BY t.created_at DESC, t.id DESC LIMIT 10`).all();
  const orders = db.prepare(`SELECT s.*, u.first_name, u.last_name, p.name AS product_name FROM standing_orders s JOIN users u ON u.id = s.user_id
    JOIN accounts a ON a.id = s.account_id JOIN products p ON p.id = a.product_id WHERE s.active = 1 ORDER BY s.day_of_month LIMIT 50`).all();
  const maturities = db.prepare(`SELECT a.*, u.first_name, u.last_name, p.name AS product_name FROM accounts a JOIN users u ON u.id = a.user_id
    JOIN products p ON p.id = a.product_id WHERE a.maturity_at IS NOT NULL AND a.status = 'actif' AND a.balance_cents > 0 ORDER BY a.maturity_at LIMIT 20`).all();
  res.render('admin/dashboard', { title: 'Tableau de bord', stats, accrued, recentUsers, recentTx, orders, maturities });
});

admin.get('/clients', (req, res) => {
  const q = str(req.query.q, 80);
  const status = str(req.query.status, 20);
  const conds = ["u.role = 'client'"]; const params = [];
  if (q) { conds.push('(u.email LIKE ? OR u.last_name LIKE ? OR u.first_name LIKE ? OR u.client_number LIKE ?)'); params.push(...Array(4).fill(`%${q}%`)); }
  if (app.locals.statusLabels[status]) { conds.push('u.status = ?'); params.push(status); }
  const clients = db.prepare(`SELECT u.*, COALESCE(SUM(a.balance_cents),0) AS total FROM users u LEFT JOIN accounts a ON a.user_id = u.id AND a.status != 'cloture'
    WHERE ${conds.join(' AND ')} GROUP BY u.id ORDER BY u.created_at DESC LIMIT 200`).all(...params);
  res.render('admin/clients', { title: 'Clients', clients, q, status });
});

admin.get('/clients/nouveau', (req, res) => res.render('admin/nouveau', { title: 'Nouveau client', error: null, values: {} }));
admin.post('/clients/nouveau', (req, res) => {
  const b = req.body;
  const values = {
    civility: str(b.civility, 5), first_name: str(b.first_name, 60), last_name: str(b.last_name, 60), email: str(b.email, 120).toLowerCase(),
    birth_date: str(b.birth_date, 10), phone: str(b.phone, 20), address: str(b.address, 160), postal_code: str(b.postal_code, 10), city: str(b.city, 80),
    reference_iban: m.normalizeIban(b.reference_iban), reference_holder: str(b.reference_holder, 120), product_id: Number(b.product_id),
  };
  const fail = (error) => res.status(400).render('admin/nouveau', { title: 'Nouveau client', error, values });
  if (!values.first_name || !values.last_name) return fail('Nom et prénom obligatoires.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) return fail('E-mail invalide.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(values.email)) return fail('E-mail déjà utilisé.');
  if (values.reference_iban && !m.isValidIban(values.reference_iban)) return fail('IBAN de référence invalide.');
  if (!bank.getProduct(values.product_id)) return fail('Choisissez un livret.');
  const p = auth.passwordProblem(b.password);
  if (p) return fail(p);
  const id = bank.createUser({ ...values, password_hash: auth.hashPassword(b.password) }, { status: 'actif' });
  bank.audit(req.user.id, 'client_cree', { userId: id });
  req.flash('success', 'Client créé. Communiquez-lui son identifiant et son mot de passe provisoire.');
  res.redirect('/admin/clients/' + id);
});

admin.get('/clients/:id', handle((req, res) => {
  const client = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'client'").get(Number(req.params.id));
  if (!client) throw new bank.BankError('Client introuvable.');
  const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY id').all(client.id).map(bank.accountView);
  const txs = db.prepare(`SELECT t.*, p.name AS product_name, adm.first_name AS admin_name FROM transactions t JOIN accounts a ON a.id = t.account_id
    JOIN products p ON p.id = a.product_id LEFT JOIN users adm ON adm.id = t.created_by WHERE a.user_id = ? ORDER BY t.created_at DESC, t.id DESC LIMIT 50`).all(client.id);
  const withdrawals = db.prepare('SELECT w.* FROM withdrawals w JOIN accounts a ON a.id = w.account_id WHERE a.user_id = ? ORDER BY w.created_at DESC LIMIT 20').all(client.id);
  const parrain = client.referred_by ? db.prepare('SELECT id, first_name, last_name FROM users WHERE id = ?').get(client.referred_by) : null;
  const filleuls = db.prepare('SELECT id, first_name, last_name, referral_paid FROM users WHERE referred_by = ?').all(client.id);
  const msgs = db.prepare('SELECT * FROM messages WHERE user_id = ? ORDER BY created_at, id').all(client.id);
  db.prepare("UPDATE messages SET read_at = datetime('now') WHERE user_id = ? AND from_admin = 0 AND read_at IS NULL").run(client.id);
  const goals = bank.userGoals(client.id);
  const orders = bank.userStandingOrders(client.id);
  const ownedProducts = accounts.filter((a) => a.status !== 'cloture').map((a) => a.product_id);
  res.render('admin/client', { title: `${client.first_name} ${client.last_name}`, customer: client, goals, orders, accounts, txs, withdrawals, parrain, filleuls, msgs,
    openable: bank.listProducts().filter((p) => !ownedProducts.includes(p.id)) });
}));

admin.post('/clients/:id/statut', handle((req, res) => {
  const status = str(req.body.status, 20);
  if (!['actif', 'bloque', 'en_attente', 'cloture'].includes(status)) throw new bank.BankError('Statut invalide.');
  const id = Number(req.params.id);
  db.prepare("UPDATE users SET status = ? WHERE id = ? AND role = 'client'").run(status, id);
  if (status === 'bloque' || status === 'cloture') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  bank.audit(req.user.id, 'statut_client', { userId: id, status });
  req.flash('success', `Statut du client : ${app.locals.statusLabels[status]}.`);
  res.redirect('/admin/clients/' + id);
}));

admin.post('/clients/:id/infos', handle((req, res) => {
  const b = req.body; const id = Number(req.params.id);
  const ib = m.normalizeIban(b.reference_iban);
  if (ib && !m.isValidIban(ib)) throw new bank.BankError('IBAN de référence invalide.');
  db.prepare("UPDATE users SET phone = ?, address = ?, postal_code = ?, city = ?, reference_iban = ?, reference_holder = ? WHERE id = ? AND role = 'client'")
    .run(str(b.phone, 20), str(b.address, 160), str(b.postal_code, 10), str(b.city, 80), ib || null, str(b.reference_holder, 120), id);
  bank.audit(req.user.id, 'infos_client', { userId: id });
  req.flash('success', 'Informations mises à jour.');
  res.redirect('/admin/clients/' + id);
}));

admin.post('/clients/:id/mot-de-passe', handle((req, res) => {
  const id = Number(req.params.id);
  const p = auth.passwordProblem(req.body.password);
  if (p) throw new bank.BankError(p);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ? AND role = 'client'").run(auth.hashPassword(req.body.password), id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  bank.audit(req.user.id, 'reinit_mdp', { userId: id });
  req.flash('success', 'Mot de passe réinitialisé.');
  res.redirect('/admin/clients/' + id);
}));

admin.post('/clients/:id/ouvrir', handle((req, res) => {
  const id = Number(req.params.id);
  bank.openAccount(id, Number(req.body.product_id));
  bank.audit(req.user.id, 'compte_ouvert', { userId: id, productId: Number(req.body.product_id) });
  req.flash('success', 'Livret ouvert.');
  res.redirect('/admin/clients/' + id);
}));

admin.post('/comptes/:id/operation', handle((req, res) => {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(req.params.id));
  if (!acc) throw new bank.BankError('Compte introuvable.');
  const amount = m.parseEuros(req.body.amount);
  if (!amount) throw new bank.BankError('Montant invalide.');
  bank.adminOperation(req.user.id, acc.id, str(req.body.kind, 20), amount, str(req.body.label, 120));
  req.flash('success', `Opération de ${m.formatEuros(amount)} enregistrée.`);
  res.redirect('/admin/clients/' + acc.user_id);
}));

admin.post('/comptes/:id/interets', handle((req, res) => {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(req.params.id));
  if (!acc) throw new bank.BankError('Compte introuvable.');
  const c = bank.payInterest(acc.id, req.user.id);
  bank.audit(req.user.id, 'interets_compte', { accountId: acc.id, cents: c });
  req.flash('success', c ? `Intérêts versés : ${m.formatEuros(c)}.` : 'Aucun intérêt à verser pour le moment.');
  res.redirect('/admin/clients/' + acc.user_id);
}));

admin.post('/comptes/:id/statut', handle((req, res) => {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(req.params.id));
  if (!acc) throw new bank.BankError('Compte introuvable.');
  const status = str(req.body.status, 20);
  if (!['actif', 'bloque', 'cloture'].includes(status)) throw new bank.BankError('Statut invalide.');
  if (status === 'cloture' && acc.balance_cents !== 0) throw new bank.BankError('Le solde doit être à zéro pour clôturer le livret (validez d’abord un retrait du solde).');
  db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, acc.id);
  bank.audit(req.user.id, 'statut_compte', { accountId: acc.id, status });
  req.flash('success', 'Statut du livret mis à jour.');
  res.redirect('/admin/clients/' + acc.user_id);
}));

admin.post('/clients/:id/prime-bienvenue', handle((req, res) => {
  bank.payWelcomeBonus(req.user.id, Number(req.params.id));
  req.flash('success', 'Prime de bienvenue versée.');
  res.redirect('/admin/clients/' + req.params.id);
}));
admin.post('/clients/:id/parrainage', handle((req, res) => {
  bank.payReferral(req.user.id, Number(req.params.id));
  req.flash('success', 'Primes de parrainage versées au filleul et au parrain.');
  res.redirect('/admin/clients/' + req.params.id);
}));

admin.post('/clients/:id/message', handle((req, res) => {
  const body = str(req.body.body, 3000);
  if (!body) throw new bank.BankError('Message vide.');
  db.prepare('INSERT INTO messages (user_id, from_admin, body) VALUES (?,1,?)').run(Number(req.params.id), body);
  req.flash('success', 'Message envoyé.');
  res.redirect('/admin/clients/' + req.params.id + '#messages');
}));

admin.get('/retraits', (req, res) => {
  const status = app.locals.statusLabels[req.query.status] ? req.query.status : 'en_attente';
  const list = db.prepare(`SELECT w.*, a.iban, a.balance_cents, a.user_id, u.first_name, u.last_name, u.reference_holder, p.name AS product_name
    FROM withdrawals w JOIN accounts a ON a.id = w.account_id JOIN users u ON u.id = a.user_id JOIN products p ON p.id = a.product_id
    WHERE w.status = ? ORDER BY w.created_at ${status === 'en_attente' ? 'ASC' : 'DESC'} LIMIT 200`).all(status);
  res.render('admin/retraits', { title: 'Demandes de retrait', list, status });
});
admin.post('/retraits/:id', handle((req, res) => {
  const approve = req.body.decision === 'valider';
  bank.processWithdrawal(req.user.id, Number(req.params.id), approve, str(req.body.note, 300));
  req.flash('success', approve ? 'Retrait validé et débité du livret.' : 'Retrait refusé.');
  res.redirect('/admin/retraits');
}));

admin.post('/interets', handle((req, res) => {
  const r = bank.payAllInterest(req.user.id);
  req.flash('success', `Intérêts versés sur ${r.count} livret(s) : ${m.formatEuros(r.total)}.`);
  res.redirect('/admin');
}));

admin.get('/messages', (req, res) => {
  const threads = db.prepare(`SELECT u.id, u.first_name, u.last_name, MAX(msg.created_at) AS last_at,
    SUM(CASE WHEN msg.from_admin = 0 AND msg.read_at IS NULL THEN 1 ELSE 0 END) AS unread
    FROM messages msg JOIN users u ON u.id = msg.user_id GROUP BY u.id ORDER BY unread DESC, last_at DESC`).all();
  res.render('admin/messages', { title: 'Messagerie', threads });
});

admin.get('/parametres', (req, res) => {
  res.render('admin/parametres', { title: 'Offres & paramètres', products: bank.listProducts(false) });
});
admin.post('/parametres', handle((req, res) => {
  const b = req.body;
  const { setSetting } = require('./db');
  for (const k of ['welcome_bonus_cents', 'referrer_bonus_cents', 'referee_bonus_cents']) {
    const v = m.parseEuros(b[k]);
    if (v === null) throw new bank.BankError('Montant de prime invalide.');
    setSetting(k, v);
  }
  if (b.offer_end_date && /^\d{4}-\d{2}-\d{2}$/.test(b.offer_end_date)) setSetting('offer_end_date', b.offer_end_date);
  bank.audit(req.user.id, 'parametres', { welcome: b.welcome_bonus_cents, referrer: b.referrer_bonus_cents, referee: b.referee_bonus_cents });
  req.flash('success', 'Paramètres enregistrés.');
  res.redirect('/admin/parametres');
}));
admin.post('/produits/:id', handle((req, res) => {
  const b = req.body; const id = Number(req.params.id);
  const num = (v) => (v === '' || v === undefined ? null : Number(String(v).replace(',', '.')));
  const base = num(b.base_rate);
  if (base === null || isNaN(base) || base < 0 || base > 20) throw new bank.BankError('Taux de base invalide.');
  const boosted = num(b.boosted_rate);
  if (boosted !== null && (isNaN(boosted) || boosted < 0 || boosted > 20)) throw new bank.BankError('Taux boosté invalide.');
  const cap = b.boost_cap ? m.parseEuros(b.boost_cap) : null;
  const max = b.max_balance ? m.parseEuros(b.max_balance) : null;
  const kind = b.kind === 'cat' ? 'cat' : 'livret';
  const term = kind === 'cat' ? Math.max(1, Number(b.term_months) || 12) : null;
  const min = b.min_deposit ? m.parseEuros(b.min_deposit) : 0;
  db.prepare('UPDATE products SET name = ?, description = ?, base_rate = ?, boosted_rate = ?, boost_months = ?, boost_cap_cents = ?, max_balance_cents = ?, active = ?, kind = ?, term_months = ?, min_deposit_cents = ? WHERE id = ?')
    .run(str(b.name, 60) || 'Livret', str(b.description, 300), base, kind === 'cat' ? null : boosted, kind === 'cat' ? 0 : Math.max(0, Number(b.boost_months) || 0), cap, max, b.active ? 1 : 0, kind, term, min || 0, id);
  bank.audit(req.user.id, 'produit', { id, base, boosted });
  req.flash('success', 'Livret mis à jour. Pensez à verser les intérêts acquis avant tout changement de taux.');
  res.redirect('/admin/parametres');
}));
admin.post('/produits', handle((req, res) => {
  const code = 'LIVRET_' + Date.now().toString(36).toUpperCase();
  db.prepare('INSERT INTO products (code, name, description, base_rate, active) VALUES (?,?,?,?,0)').run(code, 'Nouveau livret', '', 2);
  req.flash('success', 'Livret créé (inactif). Configurez-le puis activez-le.');
  res.redirect('/admin/parametres');
}));

admin.get('/journal', (req, res) => {
  const logs = db.prepare('SELECT l.*, u.first_name, u.last_name FROM audit_log l LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.id DESC LIMIT 300').all();
  res.render('admin/journal', { title: 'Journal', logs });
});

app.use('/admin', admin);

// ======================= ERREURS =======================
app.use((req, res) => res.status(404).render('error', { title: 'Page introuvable', message: "La page demandée n'existe pas." }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Erreur', message: 'Une erreur est survenue. Merci de réessayer.' });
});

if (require.main === module) {
  app.listen(config.port, () => console.log(`${config.bank.name} ${config.bank.subtitle} — http://localhost:${config.port}`));
}
module.exports = app;
