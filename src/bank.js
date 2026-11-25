// Logique métier : comptes, opérations, retraits, intérêts, primes.
const crypto = require('node:crypto');
const { db, tx, getSetting } = require('./db');
const config = require('./config');
const m = require('./money');

class BankError extends Error {}

function randomDigits(n) {
  let s = '';
  while (s.length < n) s += crypto.randomInt(0, 10);
  return s;
}

function newClientNumber() {
  for (;;) {
    const n = randomDigits(8);
    if (!db.prepare('SELECT 1 FROM users WHERE client_number = ?').get(n)) return n;
  }
}
function newReferralCode(lastName) {
  const base = String(lastName || 'CLIENT').normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 5) || 'CLIENT';
  for (;;) {
    const c = base + randomDigits(4);
    if (!db.prepare('SELECT 1 FROM users WHERE referral_code = ?').get(c)) return c;
  }
}
function newIban() {
  for (;;) {
    const iban = m.generateFrenchIban(config.bank.bankCode, config.bank.branchCode, randomDigits(11));
    if (!db.prepare('SELECT 1 FROM accounts WHERE iban = ?').get(iban)) return iban;
  }
}

function getProduct(id) { return db.prepare('SELECT * FROM products WHERE id = ?').get(id); }
function listProducts(activeOnly = true, audience = null) {
  const rows = db.prepare(`SELECT * FROM products ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`).all();
  return audience ? rows.filter((p) => p.audience === 'tous' || p.audience === audience) : rows;
}

function openAccount(userId, productId, opts = {}) {
  const p = getProduct(productId);
  if (!p || !p.active) throw new BankError('Produit indisponible.');
  const owner = db.prepare('SELECT account_type FROM users WHERE id = ?').get(userId);
  if (owner && p.audience !== 'tous' && p.audience !== owner.account_type) {
    throw new BankError(p.audience === 'pro' ? 'Ce produit est réservé aux entreprises.' : 'Ce produit est réservé aux particuliers.');
  }
  let ben = { first: null, last: null, birth: null };
  if (p.kind === 'junior') {
    ben = { first: String(opts.beneficiary_first_name || '').trim().slice(0, 60), last: String(opts.beneficiary_last_name || '').trim().slice(0, 60), birth: opts.beneficiary_birth_date || '' };
    const age = m.ageOn(ben.birth);
    if (!ben.first || !ben.last) throw new BankError("Indiquez le prénom et le nom de l'enfant.");
    if (age === null || age < 0 || age >= 18) throw new BankError("Le Livret Junior est réservé aux enfants de moins de 18 ans.");
  }
  let fixedRate = null, maturity = null;
  if (p.kind === 'cat') {
    // Compte à terme : taux figé à l'ouverture, échéance fixe
    fixedRate = p.base_rate;
    maturity = m.toDbDate(m.addMonths(new Date(), p.term_months || 12));
  }
  const r = db.prepare(`INSERT INTO accounts (user_id, product_id, iban, fixed_rate, maturity_at, beneficiary_first_name, beneficiary_last_name, beneficiary_birth_date)
    VALUES (?,?,?,?,?,?,?,?)`).run(userId, p.id, newIban(), fixedRate, maturity, ben.first, ben.last, ben.birth || null);
  return Number(r.lastInsertRowid);
}

function createUser(data, { role = 'client', status = 'en_attente' } = {}) {
  return tx(() => {
    const r = db.prepare(`INSERT INTO users (email,password_hash,role,status,civility,first_name,last_name,birth_date,phone,address,postal_code,city,reference_iban,reference_holder,client_number,referral_code,referred_by,
      account_type,company_name,siren,legal_form,company_role)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      data.email.toLowerCase(), data.password_hash, role, status, data.civility || null, data.first_name, data.last_name,
      data.birth_date || null, data.phone || null, data.address || null, data.postal_code || null, data.city || null,
      data.reference_iban ? m.normalizeIban(data.reference_iban) : null, data.reference_holder || null,
      role === 'client' ? newClientNumber() : null, role === 'client' ? newReferralCode(data.last_name) : null,
      data.referred_by || null,
      data.account_type === 'pro' ? 'pro' : 'particulier', data.company_name || null, data.siren ? String(data.siren).replace(/\s+/g, '') : null,
      data.legal_form || null, data.company_role || null,
    );
    const userId = Number(r.lastInsertRowid);
    if (role === 'client' && data.product_id) openAccount(userId, data.product_id, data);
    return userId;
  });
}

// Enregistre une opération (à appeler dans une transaction SQL)
function postTransaction(accountId, type, amountCents, label, adminId = null) {
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) throw new BankError('Montant invalide.');
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!acc) throw new BankError('Compte introuvable.');
  if (acc.status === 'cloture') throw new BankError('Compte clôturé.');
  const newBalance = acc.balance_cents + amountCents;
  if (newBalance < 0) throw new BankError('Solde insuffisant.');
  if (amountCents > 0 && type === 'depot') {
    const p = getProduct(acc.product_id);
    if (p.max_balance_cents && newBalance > p.max_balance_cents) throw new BankError(`Plafond du produit dépassé (${m.formatEuros(p.max_balance_cents)}).`);
    if (p.kind === 'cat' && p.min_deposit_cents && newBalance < p.min_deposit_cents) throw new BankError(`Versement minimum sur ce compte à terme : ${m.formatEuros(p.min_deposit_cents)}.`);
  }
  db.prepare('UPDATE accounts SET balance_cents = ? WHERE id = ?').run(newBalance, accountId);
  const r = db.prepare('INSERT INTO transactions (account_id,type,amount_cents,balance_after_cents,label,created_by) VALUES (?,?,?,?,?,?)')
    .run(accountId, type, amountCents, newBalance, label, adminId);
  return Number(r.lastInsertRowid);
}

function audit(adminId, action, details) {
  db.prepare('INSERT INTO audit_log (admin_id, action, details) VALUES (?,?,?)').run(adminId, action, typeof details === 'string' ? details : JSON.stringify(details));
}

// Crédit / débit manuel depuis l'administration
function adminOperation(adminId, accountId, kind, amountCents, label) {
  const types = { credit: 'depot', debit: 'ajustement', prime: 'prime', ajustement: 'ajustement' };
  const type = types[kind];
  if (!type) throw new BankError("Type d'opération inconnu.");
  if (!amountCents || amountCents <= 0) throw new BankError('Montant invalide.');
  const signed = kind === 'debit' ? -amountCents : amountCents;
  const defaultLabel = { credit: 'Versement reçu', debit: 'Régularisation', prime: 'Prime', ajustement: 'Régularisation' }[kind];
  return tx(() => {
    const id = postTransaction(accountId, type, signed, label || defaultLabel, adminId);
    audit(adminId, 'operation', { accountId, kind, amountCents, label });
    return id;
  });
}

function pendingWithdrawalsCents(accountId) {
  return db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM withdrawals WHERE account_id = ? AND status = 'en_attente'").get(accountId).s;
}

function requestWithdrawal(user, accountId, amountCents, note) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ? AND ? IN (user_id, co_user_id)').get(accountId, user.id);
  if (!acc) throw new BankError('Compte introuvable.');
  if (acc.status !== 'actif') throw new BankError("Ce compte n'est pas actif.");
  if (!user.reference_iban) throw new BankError('Ajoutez d’abord un compte de référence dans votre profil.');
  if (!amountCents || amountCents <= 0) throw new BankError('Montant invalide.');
  if (acc.maturity_at && m.parseDbDate(acc.maturity_at) > new Date()) {
    throw new BankError(`Compte à terme : fonds disponibles à l’échéance du ${m.parseDbDate(acc.maturity_at).toLocaleDateString('fr-FR')}.`);
  }
  const available = acc.balance_cents - pendingWithdrawalsCents(acc.id);
  if (amountCents > available) throw new BankError(`Montant supérieur au solde disponible (${m.formatEuros(available)}).`);
  db.prepare('INSERT INTO withdrawals (account_id, amount_cents, destination_iban, client_note) VALUES (?,?,?,?)')
    .run(acc.id, amountCents, user.reference_iban, note || null);
}

function cancelWithdrawal(user, withdrawalId) {
  const w = db.prepare(`SELECT w.* FROM withdrawals w JOIN accounts a ON a.id = w.account_id
    WHERE w.id = ? AND ? IN (a.user_id, a.co_user_id) AND w.status = 'en_attente'`).get(withdrawalId, user.id);
  if (!w) throw new BankError('Demande introuvable ou déjà traitée.');
  db.prepare("UPDATE withdrawals SET status = 'annule', processed_at = datetime('now') WHERE id = ?").run(w.id);
}

// Validation (le virement est exécuté par l'établissement vers le compte de référence) ou refus
function processWithdrawal(adminId, withdrawalId, approve, note) {
  return tx(() => {
    const w = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'en_attente'").get(withdrawalId);
    if (!w) throw new BankError('Demande introuvable ou déjà traitée.');
    if (approve) {
      postTransaction(w.account_id, 'retrait', -w.amount_cents, `Virement vers compte de référence ${m.formatIban(w.destination_iban).slice(-9)}`, adminId);
    } else if (!note) {
      throw new BankError('Indiquez le motif du refus.');
    }
    db.prepare("UPDATE withdrawals SET status = ?, admin_note = ?, processed_at = datetime('now'), processed_by = ? WHERE id = ?")
      .run(approve ? 'effectue' : 'refuse', note || null, adminId, w.id);
    audit(adminId, approve ? 'retrait_valide' : 'retrait_refuse', { withdrawalId, note });
  });
}

// Produit « effectif » d'un compte : un compte à terme garde son taux figé à l'ouverture
function effectiveProduct(acc, product = getProduct(acc.product_id)) {
  if (acc.fixed_rate == null) return product;
  return { ...product, base_rate: acc.fixed_rate, boosted_rate: null, boost_months: 0 };
}

function accruedInterest(acc, product = getProduct(acc.product_id), now = new Date()) {
  product = effectiveProduct(acc, product);
  // Un compte à terme cesse de produire des intérêts à son échéance
  if (acc.maturity_at && m.parseDbDate(acc.maturity_at) < now) now = m.parseDbDate(acc.maturity_at);
  const txs = db.prepare('SELECT created_at, amount_cents FROM transactions WHERE account_id = ? AND created_at > ?').all(acc.id, acc.last_interest_at);
  // Livrets : règle des quinzaines ; comptes à terme : prorata exact jusqu'à l'échéance
  return product.kind === 'cat' ? m.computeInterest(acc, product, txs, now) : m.computeInterestQuinzaine(acc, product, txs, now);
}

// Verse les intérêts acquis d'un compte
function payInterest(accountId, adminId = null, now = new Date()) {
  return tx(() => {
    const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!acc || acc.status === 'cloture') return 0;
    const r = accruedInterest(acc, undefined, now);
    if (r.until <= m.parseDbDate(acc.last_interest_at)) return 0;
    if (r.cents > 0) {
      const label = `Intérêts du ${m.parseDbDate(acc.last_interest_at).toLocaleDateString('fr-FR')} au ${r.until.toLocaleDateString('fr-FR')}`;
      postTransaction(acc.id, 'interets', r.cents, label, adminId);
    }
    db.prepare('UPDATE accounts SET last_interest_at = ? WHERE id = ?').run(m.toDbDate(r.until), acc.id);
    return r.cents;
  });
}

function payAllInterest(adminId) {
  const ids = db.prepare("SELECT id FROM accounts WHERE status != 'cloture'").all().map((r) => r.id);
  let total = 0, count = 0;
  for (const id of ids) {
    const c = payInterest(id, adminId);
    if (c > 0) { total += c; count++; }
  }
  audit(adminId, 'interets_verses', { total, count });
  return { total, count };
}

function firstAccountId(userId) {
  const a = db.prepare("SELECT id FROM accounts WHERE user_id = ? AND status = 'actif' ORDER BY id LIMIT 1").get(userId);
  if (!a) throw new BankError("Le client n'a aucun compte actif.");
  return a.id;
}

function payWelcomeBonus(adminId, userId) {
  return tx(() => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u || u.welcome_paid) throw new BankError('Prime de bienvenue déjà versée.');
    const amount = Number(getSetting('welcome_bonus_cents'));
    postTransaction(firstAccountId(userId), 'prime', amount, 'Prime de bienvenue', adminId);
    db.prepare('UPDATE users SET welcome_paid = 1 WHERE id = ?').run(userId);
    audit(adminId, 'prime_bienvenue', { userId, amount });
  });
}

function payReferral(adminId, userId) {
  return tx(() => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u || !u.referred_by) throw new BankError("Ce client n'a pas de parrain.");
    if (u.referral_paid) throw new BankError('Primes de parrainage déjà versées.');
    const parrain = db.prepare('SELECT * FROM users WHERE id = ?').get(u.referred_by);
    const refereeAmount = Number(getSetting('referee_bonus_cents'));
    const referrerAmount = Number(getSetting('referrer_bonus_cents'));
    postTransaction(firstAccountId(u.id), 'parrainage', refereeAmount, `Prime filleul — parrainé par ${parrain.first_name} ${parrain.last_name[0]}.`, adminId);
    postTransaction(firstAccountId(parrain.id), 'parrainage', referrerAmount, `Prime parrain — filleul ${u.first_name} ${u.last_name[0]}.`, adminId);
    db.prepare('UPDATE users SET referral_paid = 1 WHERE id = ?').run(u.id);
    audit(adminId, 'parrainage', { userId, parrainId: parrain.id });
  });
}

// Vue d'ensemble d'un compte pour l'affichage
function accountView(acc) {
  const product = getProduct(acc.product_id);
  const accrued = accruedInterest(acc, product);
  const rate = m.currentRate(acc, effectiveProduct(acc, product));
  const pending = pendingWithdrawalsCents(acc.id);
  const maturity = acc.maturity_at ? m.parseDbDate(acc.maturity_at) : null;
  const locked = !!(maturity && maturity > new Date());
  const holders = db.prepare('SELECT id, first_name, last_name, company_name, account_type FROM users WHERE id IN (?, ?)').all(acc.user_id, acc.co_user_id || 0);
  const holder = holders.find((h) => h.id === acc.user_id);
  const coHolder = holders.find((h) => h.id === acc.co_user_id) || null;
  const displayName = product.kind === 'junior' && acc.beneficiary_first_name ? `${product.name} — ${acc.beneficiary_first_name}`
    : coHolder ? `${product.name} (joint)` : product.name;
  return { ...acc, product, accrued, rate, pending, maturity, locked, holder, coHolder, displayName, available: locked ? 0 : acc.balance_cents - pending };
}

function userAccounts(userId) {
  return db.prepare("SELECT * FROM accounts WHERE ? IN (user_id, co_user_id) AND status != 'cloture' ORDER BY id").all(userId).map(accountView);
}

// ---------- Compte joint ----------
function inviteCoHolder(user, accountId, email) {
  const acc = db.prepare('SELECT a.*, p.kind FROM accounts a JOIN products p ON p.id = a.product_id WHERE a.id = ? AND a.user_id = ?').get(accountId, user.id);
  if (!acc) throw new BankError('Seul le titulaire principal peut ajouter un cotitulaire.');
  if (acc.kind === 'junior') throw new BankError('Un Livret Junior ne peut pas être joint.');
  if (acc.co_user_id) throw new BankError('Ce compte a déjà un cotitulaire.');
  if (user.account_type === 'pro') throw new BankError('Les comptes joints sont réservés aux particuliers.');
  const to = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new BankError('Adresse e-mail invalide.');
  if (to === user.email) throw new BankError('Vous ne pouvez pas vous inviter vous-même.');
  if (db.prepare("SELECT 1 FROM joint_invites WHERE account_id = ? AND status = 'en_attente'").get(acc.id)) throw new BankError('Une invitation est déjà en attente pour ce compte.');
  db.prepare('INSERT INTO joint_invites (account_id, from_user_id, to_email) VALUES (?,?,?)').run(acc.id, user.id, to);
}

function invitesFor(user) {
  return db.prepare(`SELECT i.*, u.first_name, u.last_name, p.name AS product_name FROM joint_invites i JOIN users u ON u.id = i.from_user_id
    JOIN accounts a ON a.id = i.account_id JOIN products p ON p.id = a.product_id WHERE i.to_email = ? AND i.status = 'en_attente'`).all(user.email);
}

function answerInvite(user, inviteId, accept) {
  return tx(() => {
    const inv = db.prepare("SELECT * FROM joint_invites WHERE id = ? AND to_email = ? AND status = 'en_attente'").get(inviteId, user.email);
    if (!inv) throw new BankError('Invitation introuvable ou déjà traitée.');
    if (accept) {
      if (user.status !== 'actif') throw new BankError('Votre dossier doit être validé avant de rejoindre un compte joint.');
      if (user.account_type === 'pro') throw new BankError('Les comptes joints sont réservés aux particuliers.');
      const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(inv.account_id);
      if (!acc || acc.co_user_id) throw new BankError('Ce compte a déjà un cotitulaire.');
      db.prepare('UPDATE accounts SET co_user_id = ? WHERE id = ?').run(user.id, acc.id);
    }
    db.prepare("UPDATE joint_invites SET status = ?, answered_at = datetime('now') WHERE id = ?").run(accept ? 'acceptee' : 'refusee', inv.id);
  });
}

function sentInvites(user) {
  return db.prepare(`SELECT i.*, p.name AS product_name FROM joint_invites i JOIN accounts a ON a.id = i.account_id JOIN products p ON p.id = a.product_id
    WHERE i.from_user_id = ? ORDER BY i.created_at DESC LIMIT 20`).all(user.id);
}

function cancelInvite(user, inviteId) {
  db.prepare("UPDATE joint_invites SET status = 'annulee', answered_at = datetime('now') WHERE id = ? AND from_user_id = ? AND status = 'en_attente'").run(inviteId, user.id);
}

// Nom affiché d'un client (raison sociale pour une entreprise)
function clientName(u) {
  return u.account_type === 'pro' && u.company_name ? u.company_name : `${u.first_name} ${u.last_name}`;
}

// ---------- Projets d'épargne ----------
function userGoals(userId) {
  const accounts = Object.fromEntries(userAccounts(userId).map((a) => [a.id, a]));
  const total = Object.values(accounts).reduce((s, a) => s + a.balance_cents, 0);
  return db.prepare('SELECT * FROM goals WHERE user_id = ? ORDER BY created_at').all(userId).map((g) => {
    const saved = g.account_id && accounts[g.account_id] ? accounts[g.account_id].balance_cents : total;
    const pct = Math.min(100, Math.round((saved / g.target_cents) * 100));
    let monthly = null;
    if (g.target_date && saved < g.target_cents) {
      const months = Math.max(1, Math.round((new Date(g.target_date) - new Date()) / (30.44 * 86400000)));
      monthly = Math.ceil((g.target_cents - saved) / months);
    }
    return { ...g, saved, pct, monthly, account: g.account_id ? accounts[g.account_id] : null };
  });
}

// ---------- Versements programmés ----------
function userStandingOrders(userId) {
  return db.prepare(`SELECT s.*, a.iban, p.name AS product_name FROM standing_orders s JOIN accounts a ON a.id = s.account_id
    JOIN products p ON p.id = a.product_id WHERE s.user_id = ? AND s.active = 1 ORDER BY s.day_of_month`).all(userId);
}

// ---------- Attestation fiscale ----------
function taxSummary(userId, year) {
  return db.prepare(`SELECT a.id, a.iban, p.name AS product_name, COALESCE(SUM(CASE WHEN t.type = 'interets' THEN t.amount_cents END),0) AS interest,
    COALESCE(SUM(CASE WHEN t.type IN ('prime','parrainage') THEN t.amount_cents END),0) AS bonuses
    FROM accounts a JOIN products p ON p.id = a.product_id
    LEFT JOIN transactions t ON t.account_id = a.id AND strftime('%Y', t.created_at) = ?
    WHERE ? IN (a.user_id, a.co_user_id) GROUP BY a.id ORDER BY a.id`).all(String(year), userId);
}

module.exports = {
  inviteCoHolder, invitesFor, answerInvite, sentInvites, cancelInvite, clientName,
  userGoals, userStandingOrders, taxSummary, effectiveProduct,
  BankError, createUser, openAccount, listProducts, getProduct, postTransaction, adminOperation,
  requestWithdrawal, cancelWithdrawal, processWithdrawal, pendingWithdrawalsCents,
  payInterest, payAllInterest, payWelcomeBonus, payReferral, accountView, userAccounts, audit, accruedInterest,
};
