/**
 * Market updater service
 * Fetches from Gamma API and updates existing Firestore markets
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MarketData } from '../App.js';
import { detectShock, checkShockAlert, cleanupOldShocks } from './shockDetector.js';
import type { GammaEvent, GammaMarket, NormalizedMarket } from './types.js';

// Initialize Firebase Admin SDK with service account (lazy initialization)
// Supports both file-based (local) and environment variable (deployed) service accounts
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serviceAccountPath = join(__dirname, 'firebase-service-account.json');

// For deployment: service account can be provided via environment variable
function getServiceAccount(): admin.ServiceAccount {
  // Check environment variable first (for deployed environments)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) as admin.ServiceAccount;
    } catch (error) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', error);
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT environment variable');
    }
  }
  
  // Fallback to file (for local development)
  const serviceAccountContent = readFileSync(serviceAccountPath, 'utf8');
  return JSON.parse(serviceAccountContent) as admin.ServiceAccount;
}

let db: admin.firestore.Firestore | null = null;

function getFirestore(): admin.firestore.Firestore {
  if (db) {
    return db;
  }
  
  try {
    const apps = admin.apps || [];
    if (apps.length === 0) {
      const serviceAccount = getServiceAccount();
      const projectId = (serviceAccount as any).project_id || (serviceAccount as any).projectId;
      
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: projectId
      });
    }
    
    // Get Firestore instance
    db = admin.firestore();
    
    // Use REST API for better network compatibility
    try {
      (db.settings as any)({ preferRest: true });
    } catch (settingsError) {
      // Ignore if settings not available
    }
    return db;
  } catch (error) {
    console.error('❌ Failed to initialize Firebase Admin SDK:', error);
    console.error('❌ Error details:', error instanceof Error ? error.stack : String(error));
    if (error instanceof Error && error.message.includes('ENOENT')) {
      console.error(`❌ Service account file not found at: ${serviceAccountPath}`);
    }
    throw new Error(`Firebase Admin SDK initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}. Make sure firebase-service-account.json exists in src/backend/`);
  }
}

const appId = 'production-calendar';

// Gamma API base URL (from Polymarket docs)
const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';

/**
 * Normalize tags array to pipe-delimited string (matching n8n logic)
 */
function tagsToString(tags: Array<{ slug?: string; label?: string }> = []): string {
  return tags
    .map(t => t.slug || t.label)
    .filter(Boolean)
    .map(t => String(t).toLowerCase().replace(/\s+/g, '_'))
    .join('|');
}

/**
 * Check if a market's end date has already passed
 * Handles multiple date formats: YYYY-MM-DD, ISO strings, timestamps
 */
function isMarketResolved(endDate: string | undefined | null, resolveDate: string | undefined | null): boolean {
  if (!endDate && !resolveDate) {
    return false; // No date info, assume not resolved
  }
  
  const dateStr = endDate || resolveDate;
  if (!dateStr) {
    return false;
  }
  
  try {
    let date: Date;
    
    // Handle ISO string format (e.g., "2026-01-31T00:00:00Z")
    if (typeof dateStr === 'string' && dateStr.includes('T')) {
      date = new Date(dateStr);
    }
    // Handle YYYY-MM-DD format
    else if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const parts = dateStr.split('-');
      date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }
    // Handle timestamp (number or string number)
    else if (typeof dateStr === 'number' || (typeof dateStr === 'string' && /^\d+$/.test(dateStr))) {
      date = new Date(Number(dateStr));
    }
    // Try parsing as-is
    else {
      date = new Date(dateStr);
    }
    
    // Check if date is valid
    if (isNaN(date.getTime())) {
      console.warn(`Invalid date format: ${dateStr}`);
      return false; // Invalid date, assume not resolved to be safe
    }
    
    // Compare with current date/time
    const now = new Date();
    
    // For YYYY-MM-DD format, compare dates only (ignore time)
    // Market is resolved if end date is before today (yesterday or earlier)
    if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endDateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      // If end date is before today, market is resolved
      return endDateOnly < today;
    }
    
    // For ISO strings with time, compare exact timestamps
    // Market is resolved if end date/time has passed
    return date < now;
  } catch (error) {
    console.warn(`Error parsing date ${dateStr}:`, error);
    return false; // On error, assume not resolved to be safe
  }
}

/**
 * Fetch a single market by ID from Gamma API
 * Tries /markets/{id} endpoint
 */
async function fetchMarketById(marketId: string): Promise<GammaMarket | null> {
  try {
    const url = `${GAMMA_API_BASE}/markets/${marketId}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null; // Market not found
      }
      console.warn(`Gamma API error for market ${marketId}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    
    // Log first market structure for debugging
    if (!(globalThis as any).__market_by_id_logged) {
      console.log('=== GAMMA API MARKET BY ID STRUCTURE (first call) ===');
      console.log('Market ID:', marketId);
      console.log('Response type:', typeof data);
      console.log('Response keys:', Object.keys(data));
      console.log('Response sample:', JSON.stringify(data, null, 2).substring(0, 1500));
      (globalThis as any).__market_by_id_logged = true;
    }
    
    return data as GammaMarket;
  } catch (error) {
    console.error(`Error fetching market ${marketId}:`, error);
    return null;
  }
}

/**
 * Fetch markets from Gamma API
 * First tries to fetch all markets, then falls back to fetching by ID if needed
 */
async function fetchGammaMarkets(marketIds?: Set<string>): Promise<GammaMarket[]> {
  const markets: GammaMarket[] = [];
  
  // If we have specific market IDs, try fetching them individually
  if (marketIds && marketIds.size > 0) {
    console.log(`Attempting to fetch ${marketIds.size} markets by ID from Gamma API...`);
    const idsArray = Array.from(marketIds);
    
    // Fetch markets in batches to avoid rate limiting
    const batchSize = 10;
    for (let i = 0; i < idsArray.length; i += batchSize) {
      const batch = idsArray.slice(i, i + batchSize);
      const promises = batch.map(id => fetchMarketById(id));
      const results = await Promise.all(promises);
      
      results.forEach((market, idx) => {
        if (market) {
          markets.push(market);
        } else {
          console.warn(`Market ${batch[idx]} not found in Gamma API`);
        }
      });
      
      // Small delay between batches
      if (i + batchSize < idsArray.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    if (markets.length > 0) {
      console.log(`Successfully fetched ${markets.length} markets by ID`);
      return markets;
    }
    
    console.log('No markets found by ID, falling back to bulk fetch...');
  }
  
  // Fallback: fetch all markets from /markets endpoint
  try {
    const url = `${GAMMA_API_BASE}/markets`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      console.warn(`Gamma API error: ${response.status} ${response.statusText}`);
      return markets;
    }

    const data = await response.json();
    
    // Log raw response structure once for verification
    if (!(globalThis as any).__gamma_logged) {
      console.log('=== GAMMA API RAW RESPONSE (first call) ===');
      console.log('Response type:', Array.isArray(data) ? 'array' : typeof data);
      if (Array.isArray(data) && data.length > 0) {
        console.log('Array length:', data.length);
        console.log('First item keys:', Object.keys(data[0]));
        console.log('First item sample:', JSON.stringify(data[0], null, 2).substring(0, 500));
      } else if (typeof data === 'object' && data !== null) {
        console.log('Response keys:', Object.keys(data));
      }
      (globalThis as any).__gamma_logged = true;
    }
    
    // Handle different response formats
    if (Array.isArray(data)) {
      // If it's an array of markets, return directly
      if (data.length > 0 && data[0].question) {
        return data as GammaMarket[];
      }
      // If it's an array of events, extract markets
      const events = data as GammaEvent[];
      events.forEach(event => {
        if (event.markets && Array.isArray(event.markets)) {
          markets.push(...event.markets);
        }
      });
      return markets;
    } else if (data.events && Array.isArray(data.events)) {
      const events = data.events as GammaEvent[];
      events.forEach(event => {
        if (event.markets && Array.isArray(event.markets)) {
          markets.push(...event.markets);
        }
      });
      return markets;
    } else if (data.markets && Array.isArray(data.markets)) {
      return data.markets as GammaMarket[];
    } else {
      console.warn('Unexpected Gamma API response format');
      return markets;
    }
  } catch (error) {
    console.error('Error fetching Gamma markets:', error);
    return markets;
  }
}

/**
 * Get all existing market IDs from Firestore
 */
async function getExistingMarketIds(): Promise<Set<string>> {
  const marketIds = new Set<string>();
  
  try {
    const firestore = getFirestore();
    const marketsRef = firestore
      .collection('artifacts')
      .doc(appId)
      .collection('public')
      .doc('data')
      .collection('markets');
    
    const snapshot = await marketsRef.limit(1000).get();
    
    snapshot.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      const data = doc.data() as MarketData;
      // Prioritize MarketID (capital, from n8n import) then marketId (camelCase)
      const marketId = (data as any).MarketID || data.marketId || (data as any).MarketId || (data as any).gammaMarketId;
      if (marketId) {
        marketIds.add(String(marketId));
      }
      // Note: We don't use data.id because it's content-based, not the Polymarket ID
    });
    
    console.log(`Found ${marketIds.size} existing markets in Firestore`);
    return marketIds;
  } catch (error) {
    console.error('Error fetching existing market IDs:', error);
    return marketIds;
  }
}

/**
 * Update a single market in Firestore
 */
async function updateMarket(
  marketId: string,
  normalized: { marketId: string; Catalyst_Name: string; Question: string; Price: string; Volume: number | string; EndDate: string; Tags: string },
  existingMarket: MarketData
): Promise<boolean> {
  try {
    const newProbability = parseFloat(normalized.Price);
    const previousProbability = existingMarket.probability || 0;
    
    // Detect shock
    const shock = detectShock(marketId, previousProbability, newProbability);
    if (shock) {
      console.log(`⚠️ Market shock detected: ${marketId} changed by ${(shock.delta * 100).toFixed(2)}%`);
    }
    
    // Update market document
    const firestore = getFirestore();
    const marketRef = firestore.collection('artifacts').doc(appId).collection('public').doc('data').collection('markets').doc(existingMarket.id);
    
    // ONLY update probability and tracking fields - preserve all other fields
    // Do NOT overwrite title, question, catalyst, etc. - only update probability
    const updateData: Partial<MarketData> = {
      probability: newProbability,
      lastUpdated: Date.now(),
      // Track probability change for shock detection
      previousProbability: existingMarket.probability,
      changeDelta: newProbability - previousProbability
      // NOTE: We intentionally do NOT update title, question, catalyst, volume, resolveDate, tags
      // These should remain as they were imported from n8n
      // Only probability should be updated from Gamma API
    };
    
    // Use update() instead of set() to only modify specified fields
    // This ensures we don't accidentally delete or overwrite other fields
    await marketRef.update(updateData);
    
    return true;
  } catch (error) {
    console.error(`Error updating market ${marketId}:`, error);
    return false;
  }
}

/**
 * Main update function
 */
export async function updateMarkets(): Promise<{
  updated: number;
  errors: number;
  shocks: number;
}> {
  const result = {
    updated: 0,
    errors: 0,
    shocks: 0
  };

  try {
    console.log('Starting market update...');
    
    // Cleanup old shocks
    cleanupOldShocks();
    
    // Get existing market IDs
    const existingMarketIds = await getExistingMarketIds();
    
    if (existingMarketIds.size === 0) {
      console.log('No existing markets found, skipping update');
      return result;
    }
    
    // Fetch all existing markets to get their data
    const firestore = getFirestore();
    const marketsRef = firestore.collection('artifacts').doc(appId).collection('public').doc('data').collection('markets');
    const snapshot = await marketsRef.get();
    // Map by marketId (Polymarket ID) for matching, not by content-based id
    const existingMarketsByMarketId = new Map<string, MarketData>();
    const existingMarketsById = new Map<string, MarketData>(); // Also keep by id for document updates
    
    snapshot.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      const data = doc.data() as MarketData;
      // Use MarketID (capital, from n8n) or marketId (camelCase) as primary key for matching
      const marketId = (data as any).MarketID || data.marketId || (data as any).MarketId;
      if (marketId) {
        existingMarketsByMarketId.set(String(marketId), data);
      } else {
        // Log first market without marketId for debugging
        if (!(globalThis as any).__no_marketid_warned) {
          console.warn(`Market ${data.id} has no MarketID/marketId field. Keys:`, Object.keys(data));
          (globalThis as any).__no_marketid_warned = true;
        }
      }
      // Also store by document id for updates
      existingMarketsById.set(data.id, data);
    });
    
    console.log(`Processing ${existingMarketsByMarketId.size} markets (by marketId)...`);
    if (existingMarketsByMarketId.size === 0) {
      console.warn('⚠️ No markets found with marketId field! Markets may need to be re-imported with MarketId.');
      if (snapshot.docs.length > 0) {
        console.warn('Sample market keys:', Object.keys(snapshot.docs[0].data()));
      }
    }
    
    // Fetch markets from Gamma API - try by ID first, then fallback to bulk
    console.log('Fetching markets from Gamma API...');
    const gammaMarkets = await fetchGammaMarkets(existingMarketIds);
    
    if (gammaMarkets.length === 0) {
      console.log('No markets returned from Gamma API');
      return result;
    }
    
    console.log(`Fetched ${gammaMarkets.length} markets from Gamma API`);
    
    // Log matching info
    const marketIdsInResponse = new Set(gammaMarkets.map(m => m.id).filter(Boolean) as string[]);
    const matchingIds = Array.from(existingMarketIds).filter(id => marketIdsInResponse.has(id));
    console.log(`Unique market IDs in Gamma response: ${marketIdsInResponse.size}`);
    console.log(`Markets in Firestore that match Gamma response: ${matchingIds.length}`);
    
    if (matchingIds.length === 0) {
      console.warn('⚠️ No matching market IDs found! This suggests ID format mismatch.');
      console.warn('Sample Firestore marketIds:', Array.from(existingMarketIds).slice(0, 5));
      console.warn('Sample Gamma API IDs:', Array.from(marketIdsInResponse).slice(0, 5));
    }
    
    // Create a map of markets by ID for quick lookup
    const marketsById = new Map<string, GammaMarket>();
    gammaMarkets.forEach(market => {
      if (market.id) {
        marketsById.set(market.id, market);
      }
    });
    
    // Process each existing market by marketId (Polymarket ID)
    // CRITICAL: Only process markets that exist in Firestore - never create new ones
    let processedCount = 0;
    let skippedCount = 0;
    let resolvedCount = 0; // Track markets skipped due to being resolved
    
    for (const marketId of existingMarketIds) {
      const existingMarket = existingMarketsByMarketId.get(marketId);
      
      if (!existingMarket) {
        // This shouldn't happen, but skip if market not in our map
        console.warn(`Market with marketId ${marketId} not found in existingMarkets map - skipping`);
        skippedCount++;
        continue;
      }
      
      // Verify this market exists in Firestore by checking it has an id
      if (!existingMarket.id) {
        console.warn(`Market with marketId ${marketId} has no document id - skipping`);
        skippedCount++;
        continue;
      }
      
      // CRITICAL: Check if market's end date has already passed - skip if resolved
      const endDate = existingMarket.resolveDate || (existingMarket as any).endDate || (existingMarket as any).EndDate;
      if (isMarketResolved(endDate, existingMarket.resolveDate)) {
        // Market has already resolved, skip updating
        resolvedCount++;
        skippedCount++;
        continue;
      }
      
      const gammaMarket = marketsById.get(marketId);
      
      if (!gammaMarket) {
        // Market not found in Gamma API - this is OK, just skip updating it
        skippedCount++;
        continue;
      }
      
      // CRITICAL: Check if market is closed or resolved in Gamma API
      if (gammaMarket.closed || gammaMarket.resolved) {
        // Market is closed/resolved in Gamma API, skip updating
        resolvedCount++;
        skippedCount++;
        continue;
      }
      
      processedCount++;
      
      try {
        // Log market structure for first few markets to debug
        if (!(globalThis as any).__market_structure_logged) {
          console.log('=== GAMMA MARKET STRUCTURE (first market) ===');
          console.log('Market ID:', marketId);
          console.log('Market keys:', Object.keys(gammaMarket));
          console.log('Market sample:', JSON.stringify(gammaMarket, null, 2).substring(0, 1000));
          (globalThis as any).__market_structure_logged = true;
        }
        
        // Try different field names for price (Gamma API might use different names)
        // Check common field names: lastTradePrice, bestBid, bestAsk, price, yesPrice, etc.
        const priceValue = (gammaMarket as any).lastTradePrice !== undefined ? (gammaMarket as any).lastTradePrice :
                          (gammaMarket as any).bestBid !== undefined ? (gammaMarket as any).bestBid :
                          (gammaMarket as any).price !== undefined ? (gammaMarket as any).price :
                          gammaMarket.yesPrice !== undefined ? gammaMarket.yesPrice :
                          (gammaMarket as any).yes_price !== undefined ? (gammaMarket as any).yes_price :
                          (gammaMarket as any).outcomePrices?.[0] !== undefined ? (gammaMarket as any).outcomePrices[0] :
                          undefined;
        
        // Validate price
        const priceNum = priceValue !== undefined ? Number(priceValue) : NaN;
        if (isNaN(priceNum) || priceNum < 0 || priceNum > 1) {
          // If price is invalid, try to use existing price from Firestore as fallback
          const existingPrice = existingMarket.probability;
          if (existingPrice !== undefined && !isNaN(existingPrice) && existingPrice >= 0 && existingPrice <= 1) {
            console.warn(`Using existing price for market ${marketId} (Gamma API price invalid: ${priceValue})`);
            // Continue with existing price
          } else {
            console.warn(`Invalid price for market ${marketId}: ${priceValue} (checked: lastTradePrice, bestBid, price, yesPrice, yes_price, outcomePrices[0])`);
            console.warn(`Market data keys:`, Object.keys(gammaMarket));
            continue;
          }
        }
        
        // Use new price if valid, otherwise fallback to existing
        const finalPrice = !isNaN(priceNum) && priceNum >= 0 && priceNum <= 1 ? priceNum : (existingMarket.probability || 0);
        
        // Create a normalized market from the Gamma market
        // We need event info - try to get it from the market or use defaults
        const normalized: NormalizedMarket = {
          marketId: marketId,
          Catalyst_Name: (gammaMarket as any).event?.title || (gammaMarket as any).title || existingMarket.catalyst || existingMarket.title || 'Unknown Event',
          Question: gammaMarket.question || existingMarket.question || existingMarket.title || '',
          Price: finalPrice.toFixed(2),
          Volume: gammaMarket.volume || (gammaMarket as any).volumeUsd || existingMarket.volume || 0,
          EndDate: gammaMarket.endDate || (gammaMarket as any).end_date || (gammaMarket as any).expirationDate || (gammaMarket as any).endDateTimestamp || existingMarket.resolveDate || '',
          Tags: (gammaMarket as any).event?.tags ? tagsToString((gammaMarket as any).event.tags) : 
                (gammaMarket as any).tags ? tagsToString((gammaMarket as any).tags) :
                (existingMarket.tags?.join('|') || '')
        };
        
        // Update market
        const updated = await updateMarket(existingMarket.id, normalized, existingMarket);
        
        if (updated) {
          result.updated++;
          
          // Check for shock
          const newProb = parseFloat(normalized.Price);
          const oldProb = existingMarket.probability || 0;
          if (Math.abs(newProb - oldProb) >= 0.05) {
            result.shocks++;
          }
        } else {
          result.errors++;
        }
      } catch (error) {
        console.error(`Error processing market ${marketId}:`, error);
        result.errors++;
      }
    }
    
    // Check for shock alerts
    const alert = checkShockAlert();
    if (alert) {
      console.log(`🚨 SHOCK ALERT: ${alert.shockCount} shocks detected in ${((alert.windowEnd - alert.windowStart) / 1000 / 60).toFixed(1)} minutes`);
      
      // Write alert to Firestore
      const firestore = getFirestore();
      const alertRef = firestore.collection('artifacts').doc(appId).collection('public').doc('data').collection('marketShockAlerts').doc(alert.id);
      await alertRef.set(alert);
    }
    
    console.log(`Market update complete: ${result.updated} updated, ${result.errors} errors, ${result.shocks} shocks`);
    console.log(`Processed ${processedCount} markets, skipped ${skippedCount} total (${resolvedCount} resolved/closed, ${skippedCount - resolvedCount} not in Gamma API or missing data)`);
    
    return result;
  } catch (error) {
    console.error('Fatal error in updateMarkets:', error);
    result.errors++;
    return result;
  }
}
