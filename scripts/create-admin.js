// Usage : npm run create-admin -- email@exemple.fr "MotDePasse123" Prénom Nom
const { db } = require('../src/db');
const auth = require('../src/auth');
const bank = require('../src/bank');

const [email, password, first = 'Admin', last = 'Banque'] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage : npm run create-admin -- email motdepasse [prénom] [nom]');
  process.exit(1);
}
const problem = auth.passwordProblem(password);
if (problem) { console.error(problem); process.exit(1); }
const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
if (existing) {
  db.prepare("UPDATE users SET password_hash = ?, role = 'admin', status = 'actif' WHERE id = ?").run(auth.hashPassword(password), existing.id);
  console.log('Administrateur mis à jour :', email);
} else {
  bank.createUser({ email, password_hash: auth.hashPassword(password), first_name: first, last_name: last }, { role: 'admin', status: 'actif' });
  console.log('Administrateur créé :', email);
}
