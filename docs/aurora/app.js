// Simulateur d'intérêts (page d'accueil)
(function () {
  const el = document.getElementById('simu');
  if (!el) return;
  const fmt = (v) => v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const boost = Number(el.dataset.boost), base = Number(el.dataset.base), months = Number(el.dataset.months);
  const cap = Number(el.dataset.cap), bonus = Number(el.dataset.bonus);
  const amount = document.getElementById('simu-amount'), monthly = document.getElementById('simu-monthly');

  function compute() {
    let bal = Number(amount.value), interest = 0;
    for (let d = 0; d < 365; d++) {
      if (d > 0 && d % 30 === 0) bal += Number(monthly.value);
      const boosted = boost && d < months * 30.4;
      if (boosted) {
        const b = cap ? Math.min(bal, cap) : bal;
        interest += (b * boost + (bal - b) * base) / 100 / 365;
      } else interest += (bal * base) / 100 / 365;
    }
    document.getElementById('simu-amount-out').textContent = fmt(Number(amount.value));
    document.getElementById('simu-monthly-out').textContent = fmt(Number(monthly.value));
    document.getElementById('simu-result').textContent = interest.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
    document.getElementById('simu-bonus').textContent = fmt(bonus);
  }
  amount.addEventListener('input', compute);
  monthly.addEventListener('input', compute);
  compute();
})();


// Copier dans le presse-papier
document.addEventListener('click', function (e) {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  navigator.clipboard.writeText(btn.getAttribute('data-copy')).then(function () {
    const old = btn.textContent; btn.textContent = 'Copié ✓';
    setTimeout(function () { btn.textContent = old; }, 1500);
  });
});

// Impression
document.addEventListener('click', function (e) {
  if (e.target.closest('[data-print]')) window.print();
});

// Inscription : particulier / entreprise
(function () {
  const choice = document.getElementById('type-choice');
  if (!choice) return;
  function apply() {
    const pro = (choice.querySelector('input:checked') || {}).value === 'pro';
    document.getElementById('company-fields').hidden = !pro;
    document.getElementById('identity-title').textContent = pro ? 'Le représentant légal' : 'Mon identité';
    let firstVisible = null, checkedVisible = false;
    document.querySelectorAll('label[data-audience]').forEach(function (l) {
      const a = l.getAttribute('data-audience');
      const show = a === 'tous' || (a === 'pro') === pro;
      l.hidden = !show;
      const input = l.querySelector('input');
      if (!show && input.checked) input.checked = false;
      if (show && !firstVisible) firstVisible = input;
      if (show && input.checked) checkedVisible = true;
    });
    if (!checkedVisible && firstVisible) firstVisible.checked = true;
  }
  choice.addEventListener('change', apply);
  apply();
})();

// Aperçu : formulaires désactivés
document.addEventListener('submit', function (e) {
  e.preventDefault();
  var t = document.getElementById('demo-toast'); if (!t) return;
  t.hidden = false; clearTimeout(window.__dt); window.__dt = setTimeout(function () { t.hidden = true; }, 2600);
});
document.addEventListener('click', function (e) { var a = e.target.closest('a[href="#"]'); if (a) e.preventDefault(); });
