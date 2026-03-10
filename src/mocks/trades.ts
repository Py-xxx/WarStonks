import type { TradeOrder } from '../types';

export const mockSellOrders: TradeOrder[] = [
  {
    id: 'arcane-universal-fallout',
    name: 'Arcane Universal Fallout',
    slug: 'arcane_universal_fallout',
    emoji: '🔮',
    qty: 4,
    yourPrice: 10,
    marketLow: 6,
    healthScore: 52,
    healthNote: 'Monitor 10m; if still undercut, reprice to 7pt',
    checkedAgo: '2s ago',
  },
  {
    id: 'kavasa-prime-band',
    name: 'Kavasa Prime Band',
    slug: 'kavasa_prime_band',
    emoji: '🪨',
    qty: 1,
    yourPrice: 7,
    marketLow: 9,
    healthScore: 54,
    healthNote: 'Capital better used in higher-yield opportunities (+40.0% efficiency)',
    checkedAgo: '2s ago',
  },
];

export const mockBuyOrders: TradeOrder[] = [];

export const mockTradeStats = {
  profitAllTime: 0,
  profit30d: 0,
  completedTrades: 0,
  openPositions: 0,
  winRate: 0,
};
