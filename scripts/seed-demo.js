// Crée des données de démonstration (admin + 2 clients). NE PAS utiliser en production.
const { db } = require('../src/db');
const auth = require('../src/auth');
const bank = require('../src/bank');
const m = require('../src/money');

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.log('La base contient déjà des utilisateurs, rien à faire.');
  process.exit(0);
}
const pw = auth.hashPassword('Demo12345!');
const adminId = bank.createUser({ email: 'admin@demo.local', password_hash: pw, first_name: 'Admin', last_name: 'Démo' }, { role: 'admin', status: 'actif' });
const boost = db.prepare("SELECT id FROM products WHERE code = 'LIVRET_BOOST'").get().id;
const ref = m.generateFrenchIban('30004', '00001', '12345678901');

const c1 = bank.createUser({ email: 'client@demo.local', password_hash: pw, civility: 'Mme', first_name: 'Camille', last_name: 'Martin', birth_date: '1990-04-12',
  phone: '0600000000', address: '10 rue de la Paix', postal_code: '75002', city: 'Paris', reference_iban: ref, reference_holder: 'Camille Martin', product_id: boost }, { status: 'actif' });
const parrainCode = db.prepare('SELECT referral_code FROM users WHERE id = ?').get(c1).referral_code;
bank.createUser({ email: 'filleul@demo.local', password_hash: pw, civility: 'M.', first_name: 'Hugo', last_name: 'Bernard', birth_date: '1985-09-30',
  address: '5 avenue Foch', postal_code: '69006', city: 'Lyon', reference_iban: m.generateFrenchIban('30002', '00550', '98765432109'), reference_holder: 'Hugo Bernard',
  product_id: boost, referred_by: c1 });

// Historique : compte ouvert il y a 40 jours
const acc = db.prepare('SELECT id FROM accounts WHERE user_id = ?').get(c1).id;
const back = (d) => m.toDbDate(new Date(Date.now() - d * 86400000));
db.prepare('UPDATE accounts SET opened_at = ?, last_interest_at = ? WHERE id = ?').run(back(40), back(40), acc);
bank.adminOperation(adminId, acc, 'credit', 1500000, 'Virement reçu — Camille Martin');
db.prepare('UPDATE transactions SET created_at = ? WHERE account_id = ?').run(back(39), acc);
bank.payWelcomeBonus(adminId, c1);
db.prepare("UPDATE transactions SET created_at = ? WHERE account_id = ? AND type = 'prime'").run(back(30), acc);
bank.payInterest(acc, adminId, new Date(Date.now() - 10 * 86400000));
db.prepare('INSERT INTO messages (user_id, from_admin, body) VALUES (?,1,?)').run(c1, 'Bienvenue ! Votre livret est actif et votre prime de bienvenue a été versée.');

// Livret Junior pour l'enfant de Camille
const junior = db.prepare("SELECT id FROM products WHERE code = 'LIVRET_JUNIOR'").get().id;
const jAcc = bank.openAccount(c1, junior, { beneficiary_first_name: 'Léo', beneficiary_last_name: 'Martin', beneficiary_birth_date: '2018-03-14' });
bank.adminOperation(adminId, jAcc, 'credit', 250000, 'Virement reçu — Camille Martin');

// Client entreprise
const livretPro = db.prepare("SELECT id FROM products WHERE code = 'LIVRET_PRO'").get().id;
const pro = bank.createUser({ email: 'pro@demo.local', password_hash: pw, civility: 'M.', first_name: 'Karim', last_name: 'Benali', birth_date: '1975-11-20',
  address: '22 rue du Commerce', postal_code: '33000', city: 'Bordeaux', reference_iban: m.generateFrenchIban('30004', '00820', '55566677788'), reference_holder: 'Boulangerie Benali SARL',
  account_type: 'pro', company_name: 'Boulangerie Benali', siren: '732829320', legal_form: 'SARL', company_role: 'Gérant', product_id: livretPro }, { status: 'actif' });
bank.adminOperation(adminId, db.prepare('SELECT id FROM accounts WHERE user_id = ?').get(pro).id, 'credit', 4500000, 'Virement reçu — Boulangerie Benali');

// Compte à terme 24 mois, projets et versement programmé
const cat = db.prepare("SELECT id FROM products WHERE code = 'CAT_24'").get().id;
const catAcc = bank.openAccount(c1, cat);
bank.adminOperation(adminId, catAcc, 'credit', 1000000, 'Virement reçu — Camille Martin');
const insGoal = db.prepare('INSERT INTO goals (user_id, account_id, name, emoji, target_cents, target_date) VALUES (?,?,?,?,?,?)');
insGoal.run(c1, acc, 'Voyage au Japon', '✈️', 1800000, '2027-09-01');
insGoal.run(c1, null, 'Apport appartement', '🏠', 4000000, '2029-06-01');
db.prepare('INSERT INTO standing_orders (user_id, account_id, amount_cents, day_of_month) VALUES (?,?,?,?)').run(c1, acc, 30000, 5);

console.log('Données de démo créées. Mot de passe pour tous : Demo12345!');
console.log('  admin@demo.local / client@demo.local / filleul@demo.local (code parrain', parrainCode + ')');
