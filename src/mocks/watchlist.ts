import type { WatchlistItem, QuickViewData, AnalysisBar } from '../types';

export const mockWatchlist: WatchlistItem[] = [
  {
    id: 'forma-blueprint',
    name: 'Forma Blueprint',
    targetPrice: 35,
    currentPrice: 32,
    entryPrice: 32,
    exitPrice: 35,
    volume: 2847,
    delta24h: 9.4,
    score: 84,
  },
  {
    id: 'primed-flow',
    name: 'Primed Flow',
    targetPrice: 180,
    currentPrice: 195,
    entryPrice: 180,
    exitPrice: 195,
    volume: 412,
    delta24h: -7.7,
    score: 61,
  },
  {
    id: 'umbra-forma',
    name: 'Umbra Forma',
    targetPrice: 600,
    currentPrice: 582,
    entryPrice: 575,
    exitPrice: 600,
    volume: 89,
    delta24h: -3.0,
    score: 48,
  },
];

export const mockQuickView: QuickViewData = {
  item: 'Forma Blueprint',
  entry: 32,
  exit: 35,
  volume: 2847,
  spread: 3,
  trend: 9.4,
  efficiency: 67.2,
  score: 84,
  sparkline: [20, 18, 15, 16, 12, 14, 9, 7, 8, 4],
};

export const mockAnalysisBars: AnalysisBar[] = [
  { label: 'Liquidity', value: 82, color: 'green' },
  { label: 'Spread',    value: 91, color: 'green' },
  { label: 'Velocity',  value: 58, color: 'amber' },
  { label: 'Margin',    value: 74, color: 'green' },
  { label: 'Volatility',value: 38, color: 'red'   },
];
