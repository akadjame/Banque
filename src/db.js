const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('client','admin')),
  status TEXT NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente','actif','bloque','cloture')),
  civility TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  birth_date TEXT,
  phone TEXT,
  address TEXT,
  postal_code TEXT,
  city TEXT,
  reference_iban TEXT,
  reference_holder TEXT,
  client_number TEXT UNIQUE,
  referral_code TEXT UNIQUE,
  referred_by INTEGER REFERENCES users(id),
  referral_paid INTEGER NOT NULL DEFAULT 0,
  welcome_paid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  base_rate REAL NOT NULL,          -- taux annuel brut en %, ex 2.25
  boosted_rate REAL,                -- taux boosté en %, ex 4.5
  boost_months INTEGER NOT NULL DEFAULT 0,
  boost_cap_cents INTEGER,          -- plafond d'application du taux boosté
  max_balance_cents INTEGER,        -- plafond de dépôt (null = illimité)
  min_deposit_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  iban TEXT NOT NULL UNIQUE,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif','bloque','cloture')),
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_interest_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  type TEXT NOT NULL CHECK (type IN ('depot','retrait','interets','prime','parrainage','ajustement')),
  amount_cents INTEGER NOT NULL,     -- positif = crédit, négatif = débit
  balance_after_cents INTEGER NOT NULL,
  label TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id, created_at);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  destination_iban TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'en_attente' CHECK (status IN ('en_attente','effectue','refuse','annule')),
  client_note TEXT,
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT,
  processed_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),   -- client concerné par la conversation
  from_admin INTEGER NOT NULL DEFAULT 0,
  subject TEXT,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migrations (ajout de colonnes sur une base existante)
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('products', 'kind', "TEXT NOT NULL DEFAULT 'livret'"); // livret | cat (compte à terme)
addColumn('products', 'term_months', 'INTEGER');                  // durée d'un compte à terme
addColumn('accounts', 'fixed_rate', 'REAL');                      // taux garanti figé à l'ouverture (CAT)
addColumn('accounts', 'maturity_at', 'TEXT');                     // échéance (CAT)

db.exec(`
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER REFERENCES accounts(id),
  name TEXT NOT NULL,
  emoji TEXT,
  target_cents INTEGER NOT NULL CHECK (target_cents > 0),
  target_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS standing_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Produits par défaut
const productCount = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
if (productCount === 0) {
  const ins = db.prepare(`INSERT INTO products (code,name,description,base_rate,boosted_rate,boost_months,boost_cap_cents,max_balance_cents,min_deposit_cents)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  ins.run('LIVRET_BOOST', 'Livret Boosté', "Taux boosté pendant 3 mois à l'ouverture, puis taux de base. Sans frais, disponible à tout moment.", 2.25, 4.5, 3, 20000000, null, 1000);
  ins.run('LIVRET_PLUS', 'Livret Plus', 'Taux fixe garanti, sans plafond, sans frais.', 2.5, null, 0, null, null, 1000);
}

// Comptes à terme par défaut
if (!db.prepare("SELECT 1 FROM products WHERE kind = 'cat'").get()) {
  const ins = db.prepare(`INSERT INTO products (code,name,description,base_rate,boost_months,min_deposit_cents,kind,term_months)
    VALUES (?,?,?,?,0,500000,'cat',?)`);
  ins.run('CAT_12', 'Compte à terme 12 mois', 'Taux fixe garanti pendant 12 mois. Capital et intérêts versés à l’échéance.', 3.0, 12);
  ins.run('CAT_24', 'Compte à terme 24 mois', 'Taux fixe garanti pendant 24 mois. Capital et intérêts versés à l’échéance.', 3.1, 24);
  ins.run('CAT_36', 'Compte à terme 36 mois', 'Taux fixe garanti pendant 36 mois. Capital et intérêts versés à l’échéance.', 3.2, 36);
}

const defaults = require('./config').defaults;
const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
setDefault.run('welcome_bonus_cents', String(defaults.welcomeBonusCents));
setDefault.run('referrer_bonus_cents', String(defaults.referrerBonusCents));
setDefault.run('referee_bonus_cents', String(defaults.refereeBonusCents));
setDefault.run('offer_end_date', defaults.offerEndDate);

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// Exécute fn dans une transaction SQL
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, tx, getSetting, setSetting };
