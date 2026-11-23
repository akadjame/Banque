(function () {
  var cfg = window.BOYAMA_CONFIG || {};
  var waBase = "https://wa.me/" + (cfg.whatsapp || "");

  // Coordonnées
  document.querySelectorAll('[data-contact="phone"]').forEach(function (a) {
    a.textContent = cfg.telephoneAffiche || a.textContent;
    a.href = "tel:+" + (cfg.whatsapp || "");
  });
  document.querySelectorAll('[data-contact="email"]').forEach(function (a) {
    a.textContent = cfg.email || a.textContent;
    a.href = "mailto:" + (cfg.email || "");
  });
  document.querySelectorAll('[data-contact="address"]').forEach(function (el) {
    el.textContent = cfg.adresse || el.textContent;
  });
  document.querySelectorAll('[data-contact="whatsapp"]').forEach(function (a) {
    a.href = waBase + "?text=" + encodeURIComponent("Bonjour BOYAMA BTP, je souhaite des informations.");
    a.target = "_blank";
    a.rel = "noopener";
  });

  // Menu mobile
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("nav");
  toggle.addEventListener("click", function () {
    var open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", open);
  });
  nav.querySelectorAll("a").forEach(function (a) {
    a.addEventListener("click", function () {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });

  // En-tête au défilement
  var header = document.querySelector(".header");
  function onScroll() { header.classList.toggle("is-scrolled", window.scrollY > 10); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Formulaire de devis : envoi par WhatsApp ou par e-mail
  var form = document.getElementById("devis-form");
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var d = new FormData(form);
    var text =
      "Demande de devis - BOYAMA BTP\n" +
      "Nom : " + d.get("nom") + "\n" +
      "Téléphone : " + d.get("tel") + "\n" +
      "Besoin : " + d.get("besoin") + "\n" +
      "Localisation : " + (d.get("ville") || "-") + "\n\n" +
      d.get("message");
    var via = (e.submitter && e.submitter.dataset.send) || "whatsapp";
    if (via === "email") {
      window.location.href = "mailto:" + cfg.email +
        "?subject=" + encodeURIComponent("Demande de devis - " + d.get("besoin")) +
        "&body=" + encodeURIComponent(text);
    } else {
      window.open(waBase + "?text=" + encodeURIComponent(text), "_blank", "noopener");
    }
  });

  document.getElementById("year").textContent = new Date().getFullYear();
})();
