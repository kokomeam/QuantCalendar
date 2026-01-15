/**
 * Data normalization logic matching n8n workflow
 * MUST match the exact n8n cleaning logic
 */

import type { GammaEvent, GammaMarket, NormalizedMarket } from './types';

/**
 * Normalize tags array to pipe-delimited string
 * Matches n8n function: tagsToString
 */
function tagsToString(tags: Array<{ slug?: string; label?: string }> = []): string {
  return tags
    .map(t => t.slug || t.label)
    .filter(Boolean)
    .map(t => String(t).toLowerCase().replace(/\s+/g, '_'))
    .join('|');
}

/**
 * Normalize a Gamma event and its markets to Firestore format
 * Applies filtering and flattening rules
 */
export function normalizeGammaEvent(
  event: GammaEvent,
  existingMarketIds: Set<string>
): NormalizedMarket[] {
  const normalized: NormalizedMarket[] = [];

  // Extract event title
  const eventTitle = event.title || '';
  if (!eventTitle) {
    console.warn('Event missing title, skipping:', event.id || 'unknown');
    return normalized;
  }

  // Normalize tags
  const tagsString = tagsToString(event.tags || []);

  // Process markets
  const markets = event.markets || [];
  
  // Filter and sort markets
  const validMarkets = markets
    .filter((market: GammaMarket) => {
      // Filtering rules (MANDATORY):
      // 1. volume ≥ 20,000 USD
      const volume = typeof market.volume === 'string' 
        ? parseFloat(market.volume.replace(/[,$\s]/g, '')) 
        : Number(market.volume) || 0;
      if (volume < 20000) return false;

      // 2. market NOT closed or resolved
      if (market.closed || market.resolved) return false;

      // 3. yes price strictly between 0.01 and 0.99
      const yesPrice = Number(market.yesPrice) || 0;
      if (yesPrice <= 0.01 || yesPrice >= 0.99) return false;

      // 4. Market must exist in Firestore (check by ID)
      const marketId = market.id;
      if (!marketId || !existingMarketIds.has(marketId)) return false;

      return true;
    })
    .sort((a: GammaMarket, b: GammaMarket) => {
      // Sort by volume descending (for "keep up to 5" rule)
      const volA = typeof a.volume === 'string' 
        ? parseFloat(a.volume.replace(/[,$\s]/g, '')) 
        : Number(a.volume) || 0;
      const volB = typeof b.volume === 'string' 
        ? parseFloat(b.volume.replace(/[,$\s]/g, '')) 
        : Number(b.volume) || 0;
      return volB - volA;
    })
    .slice(0, 5); // Keep up to 5 markets per event

  // Flatten to normalized format
  for (const market of validMarkets) {
    const yesPrice = Number(market.yesPrice) || 0;
    
    normalized.push({
      Catalyst_Name: eventTitle,
      Question: market.question || '',
      Price: yesPrice.toFixed(2),
      Volume: market.volume || 0,
      EndDate: market.endDate || '',
      Tags: tagsString
    });
  }

  return normalized;
}
