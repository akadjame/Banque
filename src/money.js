// Outils monétaires : montants en centimes (entiers), IBAN, calcul des intérêts.

const DAY_MS = 86400000;

function formatEuros(cents, { sign = false } = {}) {
  const v = (cents || 0) / 100;
  const s = v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  return sign && cents > 0 ? '+' + s : s;
}

// "1 234,56" / "1234.56" / "1234" -> 123456 ; renvoie null si invalide
function parseEuros(input) {
  if (input === undefined || input === null) return null;
  const s = String(input).replace(/[\s €]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [ent, dec = ''] = s.split('.');
  const cents = Number(ent) * 100 + Number((dec + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

function formatRate(r) {
  return Number(r).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %';
}

// ---------- IBAN ----------
function mod97(numStr) {
  let r = 0;
  for (let i = 0; i < numStr.length; i += 7) r = Number(String(r) + numStr.slice(i, i + 7)) % 97;
  return r;
}
function lettersToDigits(s) {
  return s.toUpperCase().replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
}
function normalizeIban(iban) {
  return String(iban || '').replace(/\s+/g, '').toUpperCase();
}
function isValidIban(iban) {
  const s = normalizeIban(iban);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  return mod97(lettersToDigits(s.slice(4) + s.slice(0, 4))) === 1;
}
function formatIban(iban) {
  return normalizeIban(iban).replace(/(.{4})/g, '$1 ').trim();
}
// Génère un IBAN français valide (clé RIB + clé IBAN) à partir d'un numéro de compte
function generateFrenchIban(bankCode, branchCode, accountNumber) {
  const acc = String(accountNumber).padStart(11, '0');
  const ribKey = 97 - Number((89n * BigInt(bankCode) + 15n * BigInt(branchCode) + 3n * BigInt(acc)) % 97n);
  const bban = bankCode + branchCode + acc + String(ribKey).padStart(2, '0');
  const check = 98 - mod97(lettersToDigits(bban + 'FR00'));
  return 'FR' + String(check).padStart(2, '0') + bban;
}

// SIREN : 9 chiffres, clé de Luhn
function isValidSiren(siren) {
  const s = String(siren || '').replace(/\s+/g, '');
  if (!/^\d{9}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let d = Number(s[8 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function ageOn(birthDate, on = new Date()) {
  const b = new Date(birthDate);
  if (isNaN(b)) return null;
  let age = on.getFullYear() - b.getFullYear();
  if (on.getMonth() < b.getMonth() || (on.getMonth() === b.getMonth() && on.getDate() < b.getDate())) age--;
  return age;
}

// ---------- Dates ----------
function parseDbDate(s) {
  if (s instanceof Date) return s;
  return new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
}
function toDbDate(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
function addMonths(d, n) {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + n);
  return r;
}
function boostEndDate(account, product) {
  if (!product.boosted_rate || !product.boost_months) return null;
  return addMonths(parseDbDate(account.opened_at), product.boost_months);
}

// ---------- Intérêts ----------
// Intérêts calculés au jour le jour sur le solde de fin de journée, depuis last_interest_at.
// `txs` : opérations du compte postérieures à last_interest_at (created_at, amount_cents).
// Renvoie { cents, until } : `until` = date jusqu'à laquelle les intérêts sont arrêtés (jours entiers).
function computeInterest(account, product, txs, now = new Date()) {
  const start = parseDbDate(account.last_interest_at);
  const days = Math.floor((now - start) / DAY_MS);
  if (days <= 0) return { cents: 0, exact: 0, until: start };

  const sorted = txs
    .map((t) => ({ at: parseDbDate(t.created_at).getTime(), amount: t.amount_cents }))
    .sort((a, b) => a.at - b.at);
  let balance = account.balance_cents - sorted.reduce((s, t) => s + t.amount, 0);

  const boostEnd = boostEndDate(account, product);
  const cap = product.boost_cap_cents;
  let total = 0;
  let i = 0;
  for (let d = 1; d <= days; d++) {
    const dayEnd = start.getTime() + d * DAY_MS;
    while (i < sorted.length && sorted[i].at <= dayEnd) balance += sorted[i++].amount;
    if (balance <= 0) continue;
    const dayStart = dayEnd - DAY_MS;
    if (boostEnd && dayStart < boostEnd.getTime()) {
      const boosted = cap ? Math.min(balance, cap) : balance;
      total += (boosted * product.boosted_rate + (balance - boosted) * product.base_rate) / 100 / 365;
    } else {
      total += (balance * product.base_rate) / 100 / 365;
    }
  }
  return { cents: Math.floor(total), exact: total, until: new Date(start.getTime() + days * DAY_MS) };
}

// ---------- Intérêts par quinzaine (règle des livrets d'épargne) ----------
// Une quinzaine va du 1er au 15 ou du 16 à la fin du mois (24 quinzaines par an).
// - un versement rapporte à partir de la quinzaine qui suit (date de valeur : 1er ou 16 suivant) ;
// - un retrait cesse de rapporter dès le début de la quinzaine où il a lieu.
// Chaque quinzaine complète rapporte : solde valorisé × taux / 24.
function quinzaineStart(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() >= 16 ? 16 : 1));
}
function nextQuinzaine(d) {
  const s = quinzaineStart(d);
  return s.getUTCDate() === 1 ? new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 16)) : new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
}
// Première borne de quinzaine >= d
function quinzaineCeil(d) {
  const s = quinzaineStart(d);
  return s.getTime() === d.getTime() ? s : nextQuinzaine(d);
}

function computeInterestQuinzaine(account, product, txs, now = new Date()) {
  const from = parseDbDate(account.last_interest_at);
  const start = quinzaineCeil(from);
  const sorted = txs.map((t) => ({ at: parseDbDate(t.created_at), amount: t.amount_cents })).sort((a, b) => a.at - b.at);
  // Solde à `from` : solde actuel moins les opérations postérieures
  const base = account.balance_cents - sorted.reduce((s, t) => s + t.amount, 0);
  // Date de valeur de chaque opération
  const valued = sorted.map((t) => ({ amount: t.amount, value: t.amount > 0 ? (t.at < start ? start : nextQuinzaine(t.at)) : (t.at < start ? start : quinzaineStart(t.at)) }));
  const boostEnd = boostEndDate(account, product);
  const cap = product.boost_cap_cents;
  let total = 0, q = start, count = 0;
  for (;;) {
    const end = nextQuinzaine(q);
    if (end > now) break;
    let bal = base;
    for (const v of valued) if (v.value <= q) bal += v.amount;
    if (bal > 0) {
      if (boostEnd && q < boostEnd) {
        const boosted = cap ? Math.min(bal, cap) : bal;
        total += (boosted * product.boosted_rate + (bal - boosted) * product.base_rate) / 100 / 24;
      } else {
        total += (bal * product.base_rate) / 100 / 24;
      }
    }
    q = end; count++;
  }
  return { cents: Math.floor(total), exact: total, until: count ? q : from, quinzaines: count };
}

// Taux actuellement appliqué au compte
function currentRate(account, product, now = new Date()) {
  const end = boostEndDate(account, product);
  if (end && now < end) return { rate: product.boosted_rate, boosted: true, until: end };
  return { rate: product.base_rate, boosted: false, until: null };
}

module.exports = {
  formatEuros, parseEuros, formatRate,
  isValidIban, isValidSiren, ageOn, normalizeIban, formatIban, generateFrenchIban,
  parseDbDate, toDbDate, addMonths, boostEndDate,
  computeInterest, computeInterestQuinzaine, quinzaineStart, nextQuinzaine, currentRate, DAY_MS,
};
