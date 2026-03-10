import type { PortfolioTrade } from '../types';

export const mockTrades: PortfolioTrade[] = [
  {
    id: 'wisp-prime-set-1',
    item: 'Wisp Prime Set',
    buyPrice: 0,
    sellPrice: 35,
    profit: 35,
    date: '2026-03-09',
    category: 'sets',
    holdHours: 0,
  },
  {
    id: 'wisp-prime-set-2',
    item: 'Wisp Prime Set',
    buyPrice: 0,
    sellPrice: 20,
    profit: 20,
    date: '2026-03-10',
    category: 'sets',
    holdHours: 0,
  },
];

export const mockPortfolioStats = {
  totalPlatAllTime: 55,
  totalPlat7d: 55,
  totalPlat30d: 55,
  allocatorStatus: 'off' as const,
  allocatorAllocated: null as number | null,
  allocatorExpectedNet: null as number | null,
  profit: 55,
  trades: 2,
  winRate: 100,
  avgMargin: 100,
  avgHold: 0,
  platPerHour: 0,
  bestTrade: { item: 'Wisp Prime Set', profit: 35 },
  topCategory: { name: 'sets', profit: 55 },
};

// Sparkline data points for cumulative profit chart
export const mockProfitCurve = [
  { date: '2026-03-09', value: 20 },
  { date: '2026-03-09', value: 35 },
  { date: '2026-03-10', value: 55 },
];
