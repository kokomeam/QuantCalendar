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
 * Only updates existing markets - validates types and field matching
 */
export function normalizeGammaEvent(
  event: GammaEvent,
  existingMarketIds: Set<string>
): NormalizedMarket[] {
  const normalized: NormalizedMarket[] = [];

  // Extract event title
  const eventTitle = event.title || '';
  if (!eventTitle) {
    return normalized; // Skip events without title
  }
  
  // Normalize tags
  const tagsString = tagsToString(event.tags || []);

  // Process markets - only those that exist in Firestore
  const markets = event.markets || [];
  
  for (const market of markets) {
    // Only process markets that exist in Firestore
    const marketId = market.id || '';
    if (!marketId || !existingMarketIds.has(marketId)) {
      continue;
    }
    
    // Validate and normalize yesPrice (must be valid number between 0 and 1)
    const yesPrice = Number(market.yesPrice);
    if (isNaN(yesPrice) || yesPrice < 0 || yesPrice > 1) {
      console.warn(`Invalid yesPrice for market ${marketId}: ${market.yesPrice}`);
      continue;
    }
    
    // Normalize volume (ensure it's a number or string)
    let volume: number | string = market.volume || 0;
    if (typeof volume === 'string') {
      // Try to parse, but keep as string if it contains formatting
      const parsed = parseFloat(volume.replace(/[,$\s]/g, ''));
      volume = isNaN(parsed) ? volume : parsed;
    } else {
      volume = Number(volume) || 0;
    }
    
    // Validate endDate is a string
    const endDate = typeof market.endDate === 'string' ? market.endDate : '';
    
    // Validate question is a string
    const question = typeof market.question === 'string' ? market.question : '';
    
    normalized.push({
      marketId: marketId,
      Catalyst_Name: eventTitle,
      Question: question,
      Price: yesPrice.toFixed(2),
      Volume: volume,
      EndDate: endDate,
      Tags: tagsString
    });
  }

  return normalized;
}
