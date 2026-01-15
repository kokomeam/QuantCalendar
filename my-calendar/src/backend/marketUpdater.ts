/**
 * Market updater service
 * Fetches from Gamma API and updates existing Firestore markets
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MarketData } from '../App.js';
import { normalizeGammaEvent } from './normalize.js';
import { detectShock, checkShockAlert, cleanupOldShocks } from './shockDetector.js';
import type { GammaEvent } from './types.js';

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
 * Fetch markets from Gamma API
 * Since we only update existing markets, we need to fetch all active markets
 * and match them to existing Firestore markets
 * 
 * ASSUMPTION: Gamma API endpoint structure - will log raw response for verification
 */
async function fetchGammaMarkets(): Promise<GammaEvent[]> {
  try {
    // According to Gamma API docs, we may need to fetch all markets or use a search endpoint
    // This is a placeholder - adjust based on actual API spec
    // Common patterns: /markets, /markets/active, /events
    const url = `${GAMMA_API_BASE}/markets`;
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      console.warn(`Gamma API error: ${response.status} ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    
    // Log raw response structure once for verification
    if (!(globalThis as any).__gamma_logged) {
      console.log('=== GAMMA API RAW RESPONSE (first call) ===');
      console.log('Response type:', Array.isArray(data) ? 'array' : typeof data);
      if (Array.isArray(data) && data.length > 0) {
        console.log('Array length:', data.length);
        console.log('First item keys:', Object.keys(data[0]));
      } else if (typeof data === 'object' && data !== null) {
        console.log('Response keys:', Object.keys(data));
      }
      (globalThis as any).__gamma_logged = true;
    }
    
    // Handle different response formats
    if (Array.isArray(data)) {
      return data as GammaEvent[];
    } else if (data.events && Array.isArray(data.events)) {
      return data.events as GammaEvent[];
    } else if (data.markets && Array.isArray(data.markets)) {
      return data.markets as GammaEvent[];
    } else {
      console.warn('Unexpected Gamma API response format');
      return [];
    }
  } catch (error) {
    console.error('Error fetching Gamma markets:', error);
    return [];
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
      if (data.id) {
        marketIds.add(data.id);
      }
      if ((data as any).gammaMarketId) {
        marketIds.add((data as any).gammaMarketId);
      }
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
      tags: normalized.Tags ? normalized.Tags.split('|') : existingMarket.tags,
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
    const existingMarkets = new Map<string, MarketData>();
    
    snapshot.forEach((doc: admin.firestore.QueryDocumentSnapshot) => {
      const data = doc.data() as MarketData;
      existingMarkets.set(data.id, data);
    });
    
    console.log(`Processing ${existingMarkets.size} markets...`);
    
    // Fetch all markets from Gamma API
    console.log('Fetching markets from Gamma API...');
    const gammaEvents = await fetchGammaMarkets();
    
    if (gammaEvents.length === 0) {
      console.log('No markets returned from Gamma API');
      return result;
    }
    
    console.log(`Fetched ${gammaEvents.length} events from Gamma API`);
    
    // Process Gamma events and match to existing markets by ID
    for (const gammaEvent of gammaEvents) {
      try {
        // Normalize event - this already filters by existingMarketIds
        const normalizedMarkets = normalizeGammaEvent(gammaEvent, existingMarketIds);
        
        if (normalizedMarkets.length === 0) {
          continue; // Event filtered out
        }
        
        // Process each normalized market - match by ID
        for (const normalizedMarket of normalizedMarkets) {
          // Match by market ID (already filtered by normalizeGammaEvent)
          const existingMarket = existingMarkets.get(normalizedMarket.marketId);
          
          if (!existingMarket) {
            continue; // Market not found (shouldn't happen, but skip if it does)
          }
          
          // Update market
          const updated = await updateMarket(existingMarket.id, normalizedMarket, existingMarket);
          
          if (updated) {
            result.updated++;
            
            // Check for shock
            const newProb = parseFloat(normalizedMarket.Price);
            const oldProb = existingMarket.probability || 0;
            if (Math.abs(newProb - oldProb) >= 0.05) {
              result.shocks++;
            }
          } else {
            result.errors++;
          }
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        console.error(`Error processing Gamma event:`, error);
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
