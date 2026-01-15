/**
 * Market shock detection logic
 * Tracks probability changes and creates alerts
 */

import type { MarketShock, MarketShockAlert } from './types';

const SHOCK_THRESHOLD = 0.05; // 5% absolute change
const SHOCK_COUNT_THRESHOLD = 5; // Number of shocks to trigger alert
const SHOCK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes rolling window

// In-memory storage for recent shocks (short-term)
// In production, consider using Redis or Firestore for persistence
const recentShocks: MarketShock[] = [];

/**
 * Detect if a probability change is a shock
 */
export function detectShock(
  marketId: string,
  previousProbability: number,
  newProbability: number
): MarketShock | null {
  const delta = Math.abs(newProbability - previousProbability);
  
  if (delta >= SHOCK_THRESHOLD) {
    const shock: MarketShock = {
      marketId,
      previousProbability,
      newProbability,
      delta,
      timestamp: Date.now()
    };
    
    // Add to recent shocks
    recentShocks.push(shock);
    
    // Clean up old shocks (outside window)
    const cutoff = Date.now() - SHOCK_WINDOW_MS;
    while (recentShocks.length > 0 && recentShocks[0].timestamp < cutoff) {
      recentShocks.shift();
    }
    
    return shock;
  }
  
  return null;
}

/**
 * Check if we should create a shock alert
 * Returns alert data if threshold is met, null otherwise
 */
export function checkShockAlert(): MarketShockAlert | null {
  // Count shocks in the rolling window
  const windowStart = Date.now() - SHOCK_WINDOW_MS;
  const windowShocks = recentShocks.filter(s => s.timestamp >= windowStart);
  
  if (windowShocks.length >= SHOCK_COUNT_THRESHOLD) {
    // Group by market to see which markets are shocking
    const marketShockCounts = new Map<string, number>();
    windowShocks.forEach(shock => {
      marketShockCounts.set(
        shock.marketId,
        (marketShockCounts.get(shock.marketId) || 0) + 1
      );
    });
    
    return {
      id: `shock-${Date.now()}`,
      shockCount: windowShocks.length,
      windowStart,
      windowEnd: Date.now(),
      shocks: windowShocks,
      createdAt: Date.now()
    };
  }
  
  return null;
}

/**
 * Clear old shocks (call periodically to prevent memory leak)
 */
export function cleanupOldShocks(): void {
  const cutoff = Date.now() - (SHOCK_WINDOW_MS * 2); // Keep 2x window for safety
  while (recentShocks.length > 0 && recentShocks[0].timestamp < cutoff) {
    recentShocks.shift();
  }
}
