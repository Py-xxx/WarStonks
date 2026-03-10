import type { GameEvent } from '../types';

export const mockFissures: GameEvent[] = [
  {
    id: 'thermia-fractures',
    name: 'Thermia Fractures',
    startDate: '26 Feb at 19:00 SAST',
    endDate: '12 Mar at 19:00 SAST',
    status: 'active',
    tier: 'low',
  },
  {
    id: 'void-storm-corpus',
    name: 'Void Storm — Corpus',
    startDate: '',
    endDate: 'Ends 11 Mar 04:00 SAST',
    status: 'active',
    tier: 'medium',
  },
  {
    id: 'nightwave-series-3',
    name: 'Nightwave Series 3',
    startDate: '',
    endDate: 'Ends 25 Mar 19:00 SAST',
    status: 'active',
    tier: 'low',
  },
];

export const mockActivities: GameEvent[] = [];

export const mockMarketNews: GameEvent[] = [];
