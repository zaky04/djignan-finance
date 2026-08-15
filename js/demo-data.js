/* ==========================================================================
   GeoFinance System — Données de démonstration
   Jeu de données fictif proposé au premier lancement ("Découvrir avec des
   données d'exemple"), pour se faire une idée de l'app avant d'y entrer ses
   vraies finances. Jamais mélangé silencieusement à de vraies données :
   isDemoModeActive fait apparaître un bandeau permanent (voir app.js,
   renderDemoModeBanner) invitant à tout effacer avant de commencer pour de
   bon — clearDemoData() fait exactement ça.
   ========================================================================== */

import { STORES, dbAdd, wipeAllData, setSetting } from './db.js';
import { uuid, localISODate } from './utils.js';

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localISODate(d);
}

export async function seedDemoData() {
  await wipeAllData();
  await setSetting('baseCurrency', 'XOF');

  const walletMobileMoney = { id: uuid(), name: 'Orange Money', type: 'mobile_money', currency: 'XOF', initialBalance: 42000, archived: false, createdAt: new Date().toISOString() };
  const walletBank = { id: uuid(), name: 'Compte courant', type: 'bank', currency: 'XOF', initialBalance: 185000, archived: false, createdAt: new Date().toISOString() };
  const walletCash = { id: uuid(), name: 'Espèces', type: 'cash', currency: 'XOF', initialBalance: 12000, archived: false, createdAt: new Date().toISOString() };
  for (const w of [walletMobileMoney, walletBank, walletCash]) await dbAdd(STORES.WALLETS, w);

  // wipeAllData() ci-dessus vide aussi CATEGORIES (créées une seule fois par seedDefaultsIfNeeded()
  // au tout premier boot, voir app.js) — on ne peut pas compter dessus ici, il faut recréer le même
  // jeu de catégories par défaut nous-mêmes plutôt que d'en dépendre.
  const defaultCategories = [
    { name: 'Salaire', type: 'income' },
    { name: 'Autres revenus', type: 'income' },
    { name: 'Alimentation', type: 'expense' },
    { name: 'Logement', type: 'expense' },
    { name: 'Transport', type: 'expense' },
    { name: 'Loisirs', type: 'expense' },
    { name: 'Santé', type: 'expense' },
    { name: 'Abonnements', type: 'expense' },
    { name: 'Autres dépenses', type: 'expense' },
  ];
  const categories = [];
  for (const c of defaultCategories) {
    const record = { id: uuid(), parentId: null, createdAt: new Date().toISOString(), ...c };
    await dbAdd(STORES.CATEGORIES, record);
    categories.push(record);
  }
  const cat = (name) => categories.find((c) => c.name === name)?.id || null;

  const transactions = [
    { amount: 275000, type: 'income', categoryId: cat('Salaire'), walletId: walletBank.id, date: daysAgo(58), note: 'Salaire juin' },
    { amount: 45000, type: 'expense', categoryId: cat('Logement'), walletId: walletBank.id, date: daysAgo(57), note: 'Loyer' },
    { amount: 18500, type: 'expense', categoryId: cat('Alimentation'), walletId: walletMobileMoney.id, date: daysAgo(55), note: 'Marché' },
    { amount: 8000, type: 'expense', categoryId: cat('Transport'), walletId: walletCash.id, date: daysAgo(53), note: 'Essence' },
    { amount: 12000, type: 'expense', categoryId: cat('Loisirs'), walletId: walletMobileMoney.id, date: daysAgo(50), note: 'Cinéma et sorties' },
    { amount: 6000, type: 'expense', categoryId: cat('Abonnements'), walletId: walletBank.id, date: daysAgo(48), note: 'Netflix + forfait mobile' },
    { amount: 15000, type: 'expense', categoryId: cat('Alimentation'), walletId: walletMobileMoney.id, date: daysAgo(44), note: 'Marché' },
    { amount: 20000, type: 'expense', categoryId: cat('Santé'), walletId: walletBank.id, date: daysAgo(40), note: 'Consultation + pharmacie' },
    { amount: 7500, type: 'expense', categoryId: cat('Transport'), walletId: walletCash.id, date: daysAgo(35), note: 'Essence' },
    { amount: 50000, type: 'income', categoryId: cat('Autres revenus'), walletId: walletMobileMoney.id, date: daysAgo(32), note: 'Vente en ligne' },
    { amount: 275000, type: 'income', categoryId: cat('Salaire'), walletId: walletBank.id, date: daysAgo(28), note: 'Salaire juillet' },
    { amount: 45000, type: 'expense', categoryId: cat('Logement'), walletId: walletBank.id, date: daysAgo(27), note: 'Loyer' },
    { amount: 21000, type: 'expense', categoryId: cat('Alimentation'), walletId: walletMobileMoney.id, date: daysAgo(24), note: 'Marché' },
    { amount: 9000, type: 'expense', categoryId: cat('Transport'), walletId: walletCash.id, date: daysAgo(21), note: 'Essence' },
    { amount: 6000, type: 'expense', categoryId: cat('Abonnements'), walletId: walletBank.id, date: daysAgo(19), note: 'Netflix + forfait mobile' },
    { amount: 30000, type: 'expense', categoryId: cat('Loisirs'), walletId: walletMobileMoney.id, date: daysAgo(15), note: 'Week-end entre amis' },
    { amount: 17000, type: 'expense', categoryId: cat('Alimentation'), walletId: walletMobileMoney.id, date: daysAgo(10), note: 'Marché' },
    { amount: 5000, type: 'expense', categoryId: cat('Autres dépenses'), walletId: walletCash.id, date: daysAgo(6), note: 'Imprévu' },
    { amount: 8500, type: 'expense', categoryId: cat('Transport'), walletId: walletCash.id, date: daysAgo(3), note: 'Essence' },
  ];
  for (const t of transactions) {
    await dbAdd(STORES.TRANSACTIONS, {
      id: uuid(), targetWalletId: null, tags: [], receiptBlob: null, reconciled: false,
      note: '', createdAt: new Date().toISOString(), ...t,
    });
  }

  const thisMonth = localISODate().slice(0, 7);
  await dbAdd(STORES.BUDGETS, { id: uuid(), categoryId: cat('Alimentation'), month: thisMonth, limit: 60000 });
  await dbAdd(STORES.BUDGETS, { id: uuid(), categoryId: cat('Transport'), month: thisMonth, limit: 25000 });
  await dbAdd(STORES.BUDGETS, { id: uuid(), categoryId: cat('Loisirs'), month: thisMonth, limit: 35000 });

  await dbAdd(STORES.SAVINGS_GOALS, {
    id: uuid(), name: "Fonds d'urgence", targetAmount: 500000, currentAmount: 120000, currency: 'XOF',
    targetDate: null, archived: false, createdAt: new Date().toISOString(),
  });

  const investmentId = uuid();
  await dbAdd(STORES.INVESTMENTS, {
    id: investmentId, name: 'Épargne actions', assetClass: 'actions', currency: 'XOF',
    capitalInvested: 200000, createdAt: daysAgo(58) + 'T00:00:00.000Z',
  });
  await dbAdd(STORES.INVESTMENT_ENTRIES, { id: uuid(), investmentId, type: 'valuation', amount: 215000, date: daysAgo(30) });
  await dbAdd(STORES.INVESTMENT_ENTRIES, { id: uuid(), investmentId, type: 'valuation', amount: 228000, date: daysAgo(2) });

  await dbAdd(STORES.DEBTS, {
    id: uuid(), type: 'receivable', personName: 'Cousin Amadou', principal: 30000, currency: 'XOF',
    interestRate: 0, startDate: daysAgo(20), dueDate: null, status: 'active', note: 'Prêt pour dépannage', openingTransactionId: null,
  });

  await setSetting('isDemoModeActive', true);
}

/** Efface les données de démo et remet l'app dans l'état "jamais utilisée" (réaffiche
    l'onboarding au prochain démarrage) — appelé depuis le bandeau permanent affiché tant que
    isDemoModeActive est vrai (voir app.js, renderDemoModeBanner). */
export async function clearDemoData() {
  await wipeAllData();
  await setSetting('isDemoModeActive', false);
  await setSetting('onboardingCompleted', false);
}
