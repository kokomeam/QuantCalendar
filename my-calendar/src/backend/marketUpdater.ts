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
      // Prioritize marketId (Polymarket ID) over id (content-based ID)
      if (data.marketId) {
        marketIds.add(data.marketId);
      } else if ((data as any).MarketId) {
        // Handle case variations
        marketIds.add(String((data as any).MarketId));
      } else if ((data as any).gammaMarketId) {
        marketIds.add((data as any).gammaMarketId);
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
    
    // Map normalized fields back to MarketData format
    const updateData: Partial<MarketData> = {
      probability: newProbability,
      lastUpdated: Date.now(),
      // Update other fields if they changed
      title: normalized.Question || existingMarket.title,
      catalyst: normalized.Catalyst_Name || existingMarket.catalyst,
      question: normalized.Question || existingMarket.question,
      volume: normalized.Volume,
      resolveDate: normalized.EndDate || existingMarket.resolveDate,
      tags: normalized.Tags ? normalized.Tags.split('|').map(t => t.trim().toLowerCase()).filter(t => t.length > 0) : existingMarket.tags,
      // Track probability change for shock detection
      previousProbability: existingMarket.probability,
      changeDelta: newProbability - previousProbability
    };
    
    await marketRef.set({ ...existingMarket, ...updateData }, { merge: true });
    
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
      // Use marketId (Polymarket ID) as primary key for matching
      const marketId = data.marketId || (data as any).MarketId;
      if (marketId) {
        existingMarketsByMarketId.set(String(marketId), data);
      }
      // Also store by document id for updates
      existingMarketsById.set(data.id, data);
    });
    
    console.log(`Processing ${existingMarketsByMarketId.size} markets (by marketId)...`);
    
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
    for (const marketId of existingMarketIds) {
      const existingMarket = existingMarketsByMarketId.get(marketId);
      const gammaMarket = marketsById.get(marketId);
      
      if (!existingMarket) {
        console.warn(`Market with marketId ${marketId} not found in existingMarkets map`);
        continue;
      }
      
      if (!gammaMarket) {
        continue; // Market not found in Gamma API response
      }
      
      try {
        // Create a normalized market from the Gamma market
        // We need event info - try to get it from the market or use defaults
        const normalized: NormalizedMarket = {
          marketId: marketId,
          Catalyst_Name: (gammaMarket as any).event?.title || existingMarket.catalyst || 'Unknown Event',
          Question: gammaMarket.question || existingMarket.question || '',
          Price: (Number(gammaMarket.yesPrice) || 0).toFixed(2),
          Volume: gammaMarket.volume || existingMarket.volume || 0,
          EndDate: gammaMarket.endDate || existingMarket.resolveDate || '',
          Tags: (gammaMarket as any).event?.tags ? tagsToString((gammaMarket as any).event.tags) : (existingMarket.tags?.join('|') || '')
        };
        
        // Validate price
        const yesPrice = Number(gammaMarket.yesPrice);
        if (isNaN(yesPrice) || yesPrice < 0 || yesPrice > 1) {
          console.warn(`Invalid yesPrice for market ${marketId}: ${gammaMarket.yesPrice}`);
          continue;
        }
        
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
    
    return result;
  } catch (error) {
    console.error('Fatal error in updateMarkets:', error);
    result.errors++;
    return result;
  }
}
