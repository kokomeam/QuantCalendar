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

  // Extract event title - use fallback if missing
  let eventTitle = event.title || '';
  
  // Normalize tags
  const tagsString = tagsToString(event.tags || []);

  // Process markets
  let markets = event.markets || [];
  
  // Handle case where Gamma API returns markets directly (not nested under events)
  // Check if the event itself is actually a market
  if (markets.length === 0 && (event as any).question) {
    // This is a market, not an event - wrap it in an array
    markets = [event as any as GammaMarket];
    // Use market question as event title if event title is missing
    if (!eventTitle) {
      eventTitle = (event as any).question || 'Unknown Event';
    }
  }
  
  // If still no title after checking markets, use first market's question as fallback
  if (!eventTitle && markets.length > 0 && markets[0].question) {
    eventTitle = markets[0].question;
  }
  
  // If we still have no title and no markets, skip this event
  if (!eventTitle && markets.length === 0) {
    console.warn('Event missing title and markets, skipping:', event.id || 'unknown');
    return normalized;
  }
  
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
    
    // Use market question as catalyst name fallback if event title is still missing
    const catalystName = eventTitle || market.question || 'Unknown Event';
    
    normalized.push({
      Catalyst_Name: catalystName,
      Question: market.question || '',
      Price: yesPrice.toFixed(2),
      Volume: market.volume || 0,
      EndDate: market.endDate || '',
      Tags: tagsString
    });
  }

  return normalized;
}
