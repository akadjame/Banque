const test = require('node:test');
const assert = require('node:assert');
const m = require('../src/money');

test('parseEuros', () => {
  assert.strictEqual(m.parseEuros('25 000,50'), 2500050);
  assert.strictEqual(m.parseEuros('10'), 1000);
  assert.strictEqual(m.parseEuros('1.5'), 150);
  assert.strictEqual(m.parseEuros('-5'), null);
  assert.strictEqual(m.parseEuros('abc'), null);
  assert.strictEqual(m.parseEuros('1,234'), null);
});

test('IBAN généré valide', () => {
  const iban = m.generateFrenchIban('99999', '00001', '12345678901');
  assert.ok(m.isValidIban(iban));
  assert.ok(m.isValidIban('FR76 3000 6000 0112 3456 7890 189'));
  assert.ok(!m.isValidIban('FR76 3000 6000 0112 3456 7890 188'));
});

test('intérêts : taux boosté plafonné puis taux de base', () => {
  const product = { base_rate: 2.25, boosted_rate: 4.5, boost_months: 3, boost_cap_cents: 20000000 };
  const start = new Date('2026-01-01T00:00:00Z');
  const acc = { balance_cents: 3650000, opened_at: m.toDbDate(start), last_interest_at: m.toDbDate(start) };
  // 10 jours, 36 500 € sous le plafond -> 36500 * 4.5% * 10/365 = 45 €
  const r = m.computeInterest(acc, product, [], new Date('2026-01-11T00:00:00Z'));
  assert.strictEqual(r.cents, 4500);
  // Après la fin du boost -> taux de base
  const late = { ...acc, opened_at: '2025-01-01 00:00:00' };
  assert.strictEqual(m.computeInterest(late, product, [], new Date('2026-01-11T00:00:00Z')).cents, 2250);
});

test('intérêts : versement en cours de période', () => {
  const product = { base_rate: 3.65, boosted_rate: null, boost_months: 0 };
  const start = new Date('2026-01-01T00:00:00Z');
  // solde final 20 000 €, dont 10 000 € versés au jour 5 -> 5 j sur 10k + 5 j sur 20k (~)
  const acc = { balance_cents: 2000000, opened_at: m.toDbDate(start), last_interest_at: m.toDbDate(start) };
  const txs = [{ created_at: '2026-01-05 12:00:00', amount_cents: 1000000 }];
  const r = m.computeInterest(acc, product, txs, new Date('2026-01-11T00:00:00Z'));
  // jours 1-4 : 10k (1 €/j), jours 5-10 : 20k (2 €/j) -> 4 + 12 = 16 €
  assert.strictEqual(r.cents, 1600);
});

test('SIREN et âge', () => {
  assert.ok(m.isValidSiren('732 829 320'));
  assert.ok(!m.isValidSiren('732829321'));
  assert.ok(!m.isValidSiren('12345'));
  assert.strictEqual(m.ageOn('2010-06-15', new Date('2026-06-14')), 15);
  assert.strictEqual(m.ageOn('2010-06-15', new Date('2026-06-15')), 16);
});
