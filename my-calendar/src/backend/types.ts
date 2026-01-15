/**
 * Type definitions for Polymarket Gamma API and Firestore market data
 */

export type GammaEvent = {
  id?: string;
  title?: string;
  tags?: Array<{ slug?: string; label?: string }>;
  markets?: GammaMarket[];
  [key: string]: unknown; // Allow additional fields from Gamma API
};

export type GammaMarket = {
  id?: string;
  question?: string;
  volume?: number | string;
  endDate?: string;
  yesPrice?: number;
  noPrice?: number;
  closed?: boolean;
  resolved?: boolean;
  [key: string]: unknown; // Allow additional fields from Gamma API
};

export type NormalizedMarket = {
  marketId: string; // Gamma API market ID for matching
  Catalyst_Name: string;
  Question: string;
  Price: string; // yesPrice.toFixed(2)
  Volume: number | string;
  EndDate: string;
  Tags: string; // pipe-delimited
};

export type MarketShock = {
  marketId: string;
  previousProbability: number;
  newProbability: number;
  delta: number; // absolute change
  timestamp: number;
};

export type MarketShockAlert = {
  id: string;
  shockCount: number;
  windowStart: number;
  windowEnd: number;
  shocks: MarketShock[];
  createdAt: number;
};
