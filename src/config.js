// Configuration centrale. Tout est surchargeable par variables d'environnement.
const env = process.env;

module.exports = {
  port: Number(env.PORT || 3000),
  production: env.NODE_ENV === 'production',
  dbPath: env.DB_PATH || require('node:path').join(__dirname, '..', 'data', 'banque.db'),

  // Identité de la marque (à personnaliser)
  bank: {
    name: env.BANK_NAME || 'AURORA',
    subtitle: env.BANK_SUBTITLE || 'ÉPARGNE',
    legalName: env.BANK_LEGAL_NAME || 'Aurora Épargne SAS',
    supportEmail: env.BANK_SUPPORT_EMAIL || 'support@exemple.fr',
    supportPhone: env.BANK_SUPPORT_PHONE || '01 00 00 00 00',
    bankCode: env.BANK_CODE || '99999', // code banque utilisé pour générer les IBAN internes
    branchCode: env.BRANCH_CODE || '00001',
  },

  // Montants par défaut des offres (en centimes) — modifiables dans l'admin
  defaults: {
    welcomeBonusCents: 8000,
    referrerBonusCents: 15000,
    refereeBonusCents: 15000,
    offerEndDate: '', // vide = date non affichée (« offre à durée limitée »)
  },

  sessionDays: 1, // durée de session
};
