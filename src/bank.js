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
function listProducts(activeOnly = true) {
  return db.prepare(`SELECT * FROM products ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`).all();
}

function openAccount(userId, productId) {
  const p = getProduct(productId);
  if (!p || !p.active) throw new BankError('Produit indisponible.');
  const r = db.prepare('INSERT INTO accounts (user_id, product_id, iban) VALUES (?,?,?)').run(userId, p.id, newIban());
  return Number(r.lastInsertRowid);
}

function createUser(data, { role = 'client', status = 'en_attente' } = {}) {
  return tx(() => {
    const r = db.prepare(`INSERT INTO users (email,password_hash,role,status,civility,first_name,last_name,birth_date,phone,address,postal_code,city,reference_iban,reference_holder,client_number,referral_code,referred_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      data.email.toLowerCase(), data.password_hash, role, status, data.civility || null, data.first_name, data.last_name,
      data.birth_date || null, data.phone || null, data.address || null, data.postal_code || null, data.city || null,
      data.reference_iban ? m.normalizeIban(data.reference_iban) : null, data.reference_holder || null,
      role === 'client' ? newClientNumber() : null, role === 'client' ? newReferralCode(data.last_name) : null,
      data.referred_by || null,
    );
    const userId = Number(r.lastInsertRowid);
    if (role === 'client' && data.product_id) openAccount(userId, data.product_id);
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
    if (p.max_balance_cents && newBalance > p.max_balance_cents) throw new BankError(`Plafond du livret dépassé (${m.formatEuros(p.max_balance_cents)}).`);
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
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?').get(accountId, user.id);
  if (!acc) throw new BankError('Compte introuvable.');
  if (acc.status !== 'actif') throw new BankError("Ce compte n'est pas actif.");
  if (!user.reference_iban) throw new BankError('Ajoutez d’abord un compte de référence dans votre profil.');
  if (!amountCents || amountCents <= 0) throw new BankError('Montant invalide.');
  const available = acc.balance_cents - pendingWithdrawalsCents(acc.id);
  if (amountCents > available) throw new BankError(`Montant supérieur au solde disponible (${m.formatEuros(available)}).`);
  db.prepare('INSERT INTO withdrawals (account_id, amount_cents, destination_iban, client_note) VALUES (?,?,?,?)')
    .run(acc.id, amountCents, user.reference_iban, note || null);
}

function cancelWithdrawal(user, withdrawalId) {
  const w = db.prepare(`SELECT w.* FROM withdrawals w JOIN accounts a ON a.id = w.account_id
    WHERE w.id = ? AND a.user_id = ? AND w.status = 'en_attente'`).get(withdrawalId, user.id);
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

function accruedInterest(acc, product = getProduct(acc.product_id), now = new Date()) {
  const txs = db.prepare('SELECT created_at, amount_cents FROM transactions WHERE account_id = ? AND created_at > ?').all(acc.id, acc.last_interest_at);
  return m.computeInterest(acc, product, txs, now);
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
  const rate = m.currentRate(acc, product);
  const pending = pendingWithdrawalsCents(acc.id);
  return { ...acc, product, accrued, rate, pending, available: acc.balance_cents - pending };
}

function userAccounts(userId) {
  return db.prepare("SELECT * FROM accounts WHERE user_id = ? AND status != 'cloture' ORDER BY id").all(userId).map(accountView);
}

module.exports = {
  BankError, createUser, openAccount, listProducts, getProduct, postTransaction, adminOperation,
  requestWithdrawal, cancelWithdrawal, processWithdrawal, pendingWithdrawalsCents,
  payInterest, payAllInterest, payWelcomeBonus, payReferral, accountView, userAccounts, audit, accruedInterest,
};
