import { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged
} from 'firebase/auth';
import type { User } from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  onSnapshot, 
  deleteDoc,
  writeBatch
} from 'firebase/firestore';
import { classifyBTCImpact } from './services/btcImpactService';
import { 
  Calendar as CalendarIcon, 
  ChevronLeft, 
  ChevronRight, 
  ChevronDown,
  ChevronUp,
  Settings, 
  Plus, 
  X, 
  Loader2, 
  TrendingUp, 
  TrendingDown, 
  Activity, 
  BrainCircuit,
  Trash2,
  FileJson,
  CheckCircle2,
  AlertCircle,
  Database,
  RefreshCw,
  AlertTriangle,
  GitBranch,
  Filter,
  ExternalLink
} from 'lucide-react';

// --- Constants ---
const SIGNIFICANT_CHANGE_THRESHOLD = 0.05; // 5% change threshold
const MAX_BATCH_SIZE = 490; // Firestore batch limit is 500, using 490 for safety
const MAX_PREVIEW_EVENTS = 4; // Number of events to show in calendar cell preview
const PA_NEWS_API_BASE = 'https://universal-api.panewslab.com/calendar/events';
const PA_NEWS_BATCH_SIZE = 100; // API pagination size

// --- Live Bitcoin Price Fetch (CoinGecko) ---
type BitcoinPriceData = {
  priceUsd: number;
  change24hPct: number;
  source: "CoinGecko";
  fetchedAt: string; // ISO string
};

/**
 * Fetches live Bitcoin price from CoinGecko API
 * Returns null on failure (silent error handling)
 */
const fetchLiveBitcoinPrice = async (): Promise<BitcoinPriceData | null> => {
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true'
    );
    
    if (!response.ok) {
      console.warn('CoinGecko API error:', response.status);
      return null;
    }
    
    const data = await response.json();
    
    if (!data.bitcoin || typeof data.bitcoin.usd !== 'number') {
      console.warn('Invalid CoinGecko response format');
      return null;
    }
    
    return {
      priceUsd: data.bitcoin.usd,
      change24hPct: data.bitcoin.usd_24h_change || 0,
      source: "CoinGecko",
      fetchedAt: new Date().toISOString()
    };
  } catch (error) {
    // Silent error handling - don't block analysis if price fetch fails
    console.warn('Failed to fetch Bitcoin price:', error);
    return null;
  }
};

// --- Firebase Configuration ---
// Note: Firebase API keys are safe to expose in client-side code, but using env vars is best practice
// These values can be set in a .env file (which is gitignored) or use the defaults below
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyBGeQPvG9i8g_6Tu7J1iMZoDVz8HhLfCv8",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "quantcalendar-56e73.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "quantcalendar-56e73",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "quantcalendar-56e73.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "918558213412",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:918558213412:web:d2a8e1885fb5ceeb005fb1"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = 'production-calendar';

// --- Filter Tag Groups ---
const FILTER_TAG_GROUPS = {
  bitcoin: ['bitcoin', 'federal_reserve', 'interest_rates', 'economy', 'inflation', 'macro', 'politics', 'election', 'war', 'geopolitics'],
  economy: [
    'federal_reserve', 'interest_rates', 'economy', 'inflation', 'gdp', 'employment', 'macro',
    'unemployment', 'jobs', 'cpi', 'ppi', 'retail_sales', 'consumer_spending', 'trade',
    'deficit', 'debt', 'monetary_policy', 'fiscal_policy', 'central_bank', 'ecb', 'boj',
    'fed', 'fomc', 'economic_data', 'economic_indicator', 'recession', 'growth', 'productivity'
  ],
  politics: [
    'politics', 'election', 'war', 'geopolitics', 'government', 'regulation', 'sanctions',
    'congress', 'senate', 'house', 'white_house', 'president', 'administration', 'policy',
    'legislation', 'bill', 'law', 'trade_war', 'tariffs', 'diplomacy', 'treaty', 'alliance',
    'military', 'defense', 'security', 'foreign_policy', 'domestic_policy', 'executive_order',
    'supreme_court', 'judiciary', 'voting', 'campaign', 'candidate', 'party', 'democrat', 'republican'
  ]
} as const;

type FilterType = keyof typeof FILTER_TAG_GROUPS;

// --- Types ---
export type MarketData = {
  id: string;
  title: string;
  resolveDate: string; // YYYY-MM-DD
  probability: number; // 0 to 1
  previousProbability?: number; // Track history
  changeDelta?: number; // Magnitude of last change
  lastUpdated: number; // Timestamp
  source: 'n8n' | 'manual';
  // Prediction market specific fields (optional, preserved from import)
  catalyst?: string;
  question?: string;
  volume?: string | number;
  tags?: string[]; // Array of tags parsed from pipe-delimited string
  // BTC Impact classification
  btcImpact?: 'bullish' | 'bearish' | 'neutral';
  btcImpactUpdatedAt?: string; // ISO string
  // Allow additional properties from Firebase (for forward compatibility)
  [key: string]: unknown;
};

type AnalysisResult = {
  summary: string;
  assetImpact: string;
  shortTerm: string;
  midTerm: string;
  verdict: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  intensity: string;
  rawText: string;
  timestamp: number;
};

type PANewsEvent = {
  id: string;
  date: string; // YYYY-MM-DD
  title: string;
  tags: string[];
  source: {
    name: "PA News";
    url: string;
  };
  sourceType: "panews";
};

type DayData = {
  date: string; // YYYY-MM-DD
  markets: MarketData[];
  manualEvents: string[];
  panewsEvents: PANewsEvent[];
  analysis?: AnalysisResult;
  isAnalyzing?: boolean;
  hasStaleAnalysis?: boolean; // Derived: if markets updated > analysis timestamp
  hasSignificantChange?: boolean; // Derived: if any market changed > 5%
};

// --- Helper Functions (TIMEZONE SAFE) ---

// Force Local YYYY-MM-DD to avoid UTC shifting issues
const toLocalISOString = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getDaysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();
const getFirstDayOfMonth = (year: number, month: number) => new Date(year, month, 1).getDay();

// Parse strictly as local components
// Returns a valid Date object, or throws if invalid
const parseDate = (dateStr: string): Date => {
  if (!dateStr || typeof dateStr !== 'string') {
    throw new Error('Invalid date string: must be a non-empty string');
  }
  
  // Validate YYYY-MM-DD format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) {
    throw new Error(`Invalid date format: expected YYYY-MM-DD, got ${dateStr}`);
  }
  
  const parts = dateStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]) - 1; // 0-indexed
  const day = Number(parts[2]);
  
  // Validate numeric values
  if (isNaN(year) || isNaN(month) || isNaN(day)) {
    throw new Error(`Invalid date components: ${dateStr}`);
  }
  
  const date = new Date(year, month, day);
  
  // Verify the date is valid (handles cases like Feb 30)
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    throw new Error(`Invalid date: ${dateStr} (e.g., Feb 30 doesn't exist)`);
  }
  
  return date;
};

// --- Robust Data Normalizer (Case Insensitive + Content ID) ---
const normalizeMarketData = (item: Record<string, unknown>): Partial<MarketData> | null => {
  // 1. Unwrap n8n "json" property if it exists
  const data = (item.json as Record<string, unknown>) || item;

  // Helper: Find value by checking list of keys AND case-insensitive match
  const getValue = (keys: string[]): unknown => {
    // A. Check exact matches first
    for (const k of keys) {
        if (data[k] !== undefined && data[k] !== null) return data[k];
    }
    // B. Check case-insensitive matches (slower but safer)
    const dataKeys = Object.keys(data);
    for (const k of keys) {
        const foundKey = dataKeys.find(dk => dk.toLowerCase() === k.toLowerCase());
        if (foundKey) return data[foundKey];
    }
    return undefined;
  };

  // 2. Find Title 
  const title = getValue(['title', 'question', 'catalyst', 'market', 'name', 'event']);
  if (!title || (typeof title !== 'string' && typeof title !== 'number')) return null;

  // 3. Find & Parse Date
  const dateVal = getValue(['resolveDate', 'endDate', 'end_date', 'date', 'expirationDate', 'expiration']);
  let resolveDate = '';
  
  if (dateVal !== undefined && dateVal !== null) {
    if (typeof dateVal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
       resolveDate = dateVal;
    } else if (typeof dateVal === 'string' || typeof dateVal === 'number' || dateVal instanceof Date) {
        try {
            const d = new Date(dateVal as string | number | Date);
            if (!isNaN(d.getTime())) {
                resolveDate = toLocalISOString(d);
            }
        } catch (e) { console.warn("Date parse error", dateVal); }
    }
  }

  // 4. Find Probability
  const probValRaw = getValue(['probability', 'prob', 'price', 'last_price', 'value']);
  let probVal = 0;
  if (probValRaw !== undefined && probValRaw !== null) {
    const numVal = typeof probValRaw === 'number' ? probValRaw : Number(probValRaw);
    if (!isNaN(numVal)) {
      probVal = numVal;
  if (probVal > 1) probVal = probVal / 100; // Normalize %
    }
  }
  
  // 5. ID Generation (CONTENT BASED) - Ignore numeric ID from n8n
  // We clean the title to be safe for ID usage
  const cleanTitle = String(title).replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 50);
  const id = `n8n-${cleanTitle}-${resolveDate}`;

  if (!resolveDate) return null; // Skip if no valid date found

  // 6. Preserve prediction market specific fields if they exist
  const catalyst = getValue(['catalyst', 'Catalyst']);
  const question = getValue(['question', 'Question']);
  const volume = getValue(['volume', 'Volume']);
  const tagsValue = getValue(['tags', 'Tags', 'tag', 'Tag']);

  const result: Partial<MarketData> = {
    id,
    title: String(title),
    resolveDate,
    probability: probVal,
    source: 'n8n'
  };

  // Preserve prediction market fields if present
  if (catalyst !== undefined && catalyst !== null) {
    result.catalyst = String(catalyst);
  }
  if (question !== undefined && question !== null) {
    result.question = String(question);
  }
  if (volume !== undefined && volume !== null) {
    // Keep as string or number
    result.volume = typeof volume === 'string' || typeof volume === 'number' ? volume : String(volume);
  }
  
  // Parse tags from pipe-delimited string
  if (tagsValue !== undefined && tagsValue !== null) {
    const tagsStr = String(tagsValue).trim();
    if (tagsStr) {
      result.tags = tagsStr.split('|').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
    } else {
      result.tags = [];
    }
  } else {
    result.tags = [];
  }

  return result;
};

// --- Mock Data Generator ---
const generateMockData = (): MarketData[] => {
  const today = new Date();
  const mocks: MarketData[] = [];
  const events = [
    "BTC breaks $100k", "ETH ETF Approval", "Fed Interest Rate Decision", 
    "Solana Network Upgrade", "Ripple vs SEC Settlement", "Binance New Listing"
  ];
  
  for (let i = 0; i < 15; i++) {
    const randomDay = new Date(today.getFullYear(), today.getMonth(), Math.floor(Math.random() * 28) + 1);
    const dateStr = toLocalISOString(randomDay);
    const title = events[Math.floor(Math.random() * events.length)];
    const cleanTitle = title.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    
    mocks.push({
      id: `n8n-${cleanTitle}-${dateStr}`,
      title: title,
      resolveDate: dateStr, 
      probability: Math.random(),
      lastUpdated: Date.now(),
      source: 'n8n'
    });
  }
  return mocks;
};

// --- PA News API Ingestion (Backend Function) ---

/**
 * TODO: MOVE TO FIREBASE CLOUD FUNCTIONS
 * 
 * This function should be moved to a Firebase Callable Function or HTTP endpoint.
 * Current implementation runs client-side for development.
 * 
 * To migrate:
 * 1. Create Firebase Cloud Function: functions/src/index.ts
 * 2. Export as callable function: export const ingestPanewsEvents = functions.https.onCall(...)
 * 3. Update frontend to call: const ingestPanewsEvents = httpsCallable(functions, 'ingestPanewsEvents')
 * 4. Remove client-side fetch logic
 */

type IngestPANewsResult = {
  daysUpdated: number;
  eventsInserted: number;
  errors: string[];
};

type IngestPANewsOptions = {
  // TODO: Make date range user-configurable in UI
  startDate?: Date; // Default: today (UTC)
  endDate?: Date;   // Default: today + 90 days (UTC)
};

/**
 * Backend ingestion function for PA News calendar events
 * 
 * Fetches, normalizes, and stores PA News events in Firestore.
 * Designed to be moved to Firebase Cloud Functions.
 * 
 * @param db - Firestore database instance
 * @param appId - Application ID for Firestore path
 * @param options - Optional date range (defaults to next 90 days)
 * @returns Summary of ingestion results
 */
const ingestPanewsEvents = async (
  db: ReturnType<typeof getFirestore>,
  appId: string,
  options: IngestPANewsOptions = {}
): Promise<IngestPANewsResult> => {
  const errors: string[] = [];
  let eventsInserted = 0;
  const daysUpdatedSet = new Set<string>();

  try {
    // Default date range: today to +90 days (UTC)
    const startDate = options.startDate || new Date();
    const endDate = options.endDate || (() => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + 90);
      return d;
    })();

    // Normalize to UTC start of day
    startDate.setUTCHours(0, 0, 0, 0);
    endDate.setUTCHours(23, 59, 59, 999);

    const startISO = startDate.toISOString();
    const endISO = endDate.toISOString();
    const dateRange = `between,${startISO},${endISO}`;

    // Fetch all events with pagination
    const allRawEvents: unknown[] = [];
    let skip = 0;
    let hasMore = true;

    while (hasMore) {
      try {
        const url = new URL(PA_NEWS_API_BASE);
        url.searchParams.set('take', String(PA_NEWS_BATCH_SIZE));
        url.searchParams.set('skip', String(skip));
        url.searchParams.set('startAt', dateRange);

        const apiUrl = url.toString();
        console.log('🔍 PA News API Request:', {
          url: apiUrl,
          startISO,
          endISO,
          dateRange,
          take: PA_NEWS_BATCH_SIZE,
          skip
        });

        const response = await fetch(apiUrl);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          console.error('❌ PA News API Error:', {
            status: response.status,
            statusText: response.statusText,
            body: errorText
          });
          throw new Error(`PA News API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log('📥 PA News API Response:', {
          dataType: typeof data,
          isArray: Array.isArray(data),
          keys: typeof data === 'object' && data !== null ? Object.keys(data) : [],
          dataSample: Array.isArray(data) ? data.slice(0, 2) : data
        });

        // Handle different possible response formats
        let events: unknown[] = [];
        if (Array.isArray(data)) {
          events = data;
          console.log(`✅ Found ${events.length} events (direct array)`);
        } else if (data.data && Array.isArray(data.data)) {
          events = data.data;
          console.log(`✅ Found ${events.length} events (data.data)`);
        } else if (data.events && Array.isArray(data.events)) {
          events = data.events;
          console.log(`✅ Found ${events.length} events (data.events)`);
        } else {
          console.warn('⚠️ Unexpected PA News API response format:', {
            data,
            dataType: typeof data,
            keys: typeof data === 'object' && data !== null ? Object.keys(data) : []
          });
          break;
        }

        if (events.length === 0) {
          hasMore = false;
          break;
        }

        allRawEvents.push(...events);

        // If we got fewer than requested, we've reached the end
        if (events.length < PA_NEWS_BATCH_SIZE) {
          hasMore = false;
        } else {
          skip += PA_NEWS_BATCH_SIZE;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error during API fetch';
        errors.push(`Pagination error at skip=${skip}: ${errorMsg}`);
        console.error('Error fetching PA News events:', error);
        break;
      }
    }

    console.log(`📊 Total raw events fetched: ${allRawEvents.length}`);

    // Normalize all events
    const normalizedEvents: PANewsEvent[] = [];
    for (const item of allRawEvents) {
      if (typeof item === 'object' && item !== null) {
        try {
          const normalized = normalizePANewsEvent(item as Record<string, unknown>);
          if (normalized) {
            normalizedEvents.push(normalized);
          } else {
            console.warn('⚠️ Event normalized to null:', item);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown normalization error';
          errors.push(`Normalization error: ${errorMsg}`);
          console.warn('❌ Error normalizing PA News event:', error, item);
        }
      }
    }

    console.log(`✅ Total normalized events: ${normalizedEvents.length}`);

    if (normalizedEvents.length === 0) {
      return {
        daysUpdated: 0,
        eventsInserted: 0,
        errors: errors.length > 0 ? errors : ['No valid events found in date range']
      };
    }

    // Group events by date for storage
    const eventsByDate = new Map<string, PANewsEvent[]>();
    normalizedEvents.forEach(event => {
      if (!eventsByDate.has(event.date)) {
        eventsByDate.set(event.date, []);
      }
      eventsByDate.get(event.date)!.push(event);
    });

    // Store in Firestore with idempotency
    // Use date as document ID, replace events array (idempotent by event ID)
    let currentBatch = writeBatch(db);
    let batchCount = 0;

    for (const [date, events] of eventsByDate.entries()) {
      if (batchCount >= MAX_BATCH_SIZE) {
        // Commit current batch and start new one
        await currentBatch.commit();
        currentBatch = writeBatch(db);
        batchCount = 0;
      }

      const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'pa_events', date);
      
      // Idempotency: Deduplicate events by ID before storing
      const uniqueEvents = Array.from(
        new Map(events.map(e => [e.id, e])).values()
      );

      currentBatch.set(docRef, { events: uniqueEvents }, { merge: false });
      daysUpdatedSet.add(date);
      eventsInserted += uniqueEvents.length;
      batchCount++;
    }

    if (batchCount > 0) {
      await currentBatch.commit();
    }

    return {
      daysUpdated: daysUpdatedSet.size,
      eventsInserted,
      errors
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    errors.push(`Fatal error: ${errorMsg}`);
    console.error('Fatal error in ingestPanewsEvents:', error);
    return {
      daysUpdated: daysUpdatedSet.size,
      eventsInserted,
      errors
    };
  }
};


/**
 * Normalizes a PA News API event to internal format
 * 
 * PA News event schema:
 * {
 *   id, startAt, ignoreTime, categoryId, articleId, eventId,
 *   url, createdAt, updatedAt, translations, event
 * }
 */
const normalizePANewsEvent = (item: Record<string, unknown>): PANewsEvent | null => {
  try {
    // Debug: Log available keys
    const availableKeys = Object.keys(item);
    
    // Title resolution: translations is an array, not an object
    // Each element: { language: string, title: string, description?: string }
    let resolvedTitle: string | undefined;
    
    if (item.translations && Array.isArray(item.translations) && item.translations.length > 0) {
      // Find English translation first
      const enTranslation = item.translations.find((t: unknown) => {
        if (typeof t === 'object' && t !== null) {
          const trans = t as Record<string, unknown>;
          return trans.language === 'en' && trans.title && typeof trans.title === 'string';
        }
        return false;
      });
      
      if (enTranslation) {
        const trans = enTranslation as Record<string, unknown>;
        resolvedTitle = trans.title as string;
      } else {
        // Use first translation's title if no English
        const firstTranslation = item.translations[0];
        if (typeof firstTranslation === 'object' && firstTranslation !== null) {
          const trans = firstTranslation as Record<string, unknown>;
          if (trans.title && typeof trans.title === 'string') {
            resolvedTitle = trans.title;
          }
        }
      }
    }
    
    // Validate title - return null if translations is empty or missing
    if (!resolvedTitle || typeof resolvedTitle !== 'string' || !resolvedTitle.trim()) {
      console.warn('⚠️ Missing title field. Available keys:', availableKeys, 'Item:', item);
      return null;
    }
    
    // Temporary debug log
    console.log("Resolved PA title:", resolvedTitle);
    
    // Date: Use startAt directly, normalize to YYYY-MM-DD
    let dateStr = '';
    const dateValue = item.startAt;
    
    if (dateValue) {
      if (typeof dateValue === 'string') {
        // Try to parse ISO string
        const date = new Date(dateValue);
        if (!isNaN(date.getTime())) {
          dateStr = toLocalISOString(date);
        } else {
          console.warn('⚠️ Invalid date string:', dateValue, 'Available keys:', availableKeys);
          return null;
        }
      } else if (dateValue instanceof Date) {
        dateStr = toLocalISOString(dateValue);
      } else {
        console.warn('⚠️ Date value is not string or Date:', dateValue, 'Type:', typeof dateValue, 'Available keys:', availableKeys);
        return null;
      }
    } else {
      console.warn('⚠️ Missing startAt field. Available keys:', availableKeys, 'Item:', item);
      return null;
    }
    
    // Tags: Convert categoryId to string tag, store as single-element array
    let tags: string[] = [];
    if (item.categoryId !== undefined && item.categoryId !== null) {
      const categoryIdStr = String(item.categoryId).trim().toLowerCase();
      if (categoryIdStr.length > 0) {
        tags = [categoryIdStr];
      }
    }
    
    // Source: Use url directly
    const sourceUrl = item.url && typeof item.url === 'string' && item.url.trim()
      ? item.url.trim()
      : `https://panewslab.com/calendar`; // Fallback URL
    
    // Generate ID based on title and date (idempotent)
    const cleanTitle = resolvedTitle.replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 50);
    const id = `panews-${cleanTitle}-${dateStr}`;
    
    return {
      id,
      date: dateStr,
      title: resolvedTitle.trim(),
      tags,
      source: {
        name: "PA News",
        url: sourceUrl
      },
      sourceType: "panews"
    };
  } catch (error) {
    console.warn('Error normalizing PA News event:', error, item);
    return null;
  }
};

// --- Prediction Market Filtering Helper ---
/**
 * Filters prediction markets to show only one market per catalyst (highest volume).
 * This is a presentation-layer filter for calendar cells only.
 * All markets remain in the data and are shown in the detail modal.
 */
const selectTopVolumeMarketPerCatalyst = (markets: MarketData[]): MarketData[] => {
  // Separate prediction markets (those with catalyst) from other markets
  const predictionMarkets = markets.filter(m => m.catalyst);
  const otherMarkets = markets.filter(m => !m.catalyst);

  if (predictionMarkets.length === 0) {
    return markets; // No prediction markets, return all as-is
  }

  // Group prediction markets by catalyst
  const groupedByCatalyst = new Map<string, MarketData[]>();
  predictionMarkets.forEach(market => {
    const catalyst = String(market.catalyst || '').trim();
    if (!catalyst) return; // Skip if catalyst is empty
    
    if (!groupedByCatalyst.has(catalyst)) {
      groupedByCatalyst.set(catalyst, []);
    }
    groupedByCatalyst.get(catalyst)!.push(market);
  });

  // For each catalyst group, select the market with highest volume
  const selectedMarkets: MarketData[] = [];
  groupedByCatalyst.forEach((groupMarkets) => {
    // Find market with highest volume
    let topMarket = groupMarkets[0];
    let maxVolume = 0;

    for (const market of groupMarkets) {
      // Normalize volume: handle both string and number, default to 0
      let volume = 0;
      if (market.volume !== undefined && market.volume !== null) {
        if (typeof market.volume === 'string') {
          // Try to parse string (remove commas, handle currency, etc.)
          const cleaned = market.volume.replace(/[,$\s]/g, '');
          volume = parseFloat(cleaned) || 0;
        } else {
          volume = Number(market.volume) || 0;
        }
      }

      if (volume > maxVolume) {
        maxVolume = volume;
        topMarket = market;
      }
    }

    selectedMarkets.push(topMarket);
  });

  // Combine selected prediction markets with other markets
  return [...selectedMarkets, ...otherMarkets];
};

// --- AI Analysis Service ---
const analyzeDay = async (
  date: string, 
  markets: MarketData[], 
  events: string[], 
  apiKey: string
): Promise<AnalysisResult> => {
  if (!apiKey) throw new Error("OpenAI API Key is missing");

  const eventsList = [
    ...markets.map(m => {
        const changeStr = m.changeDelta ? ` (Changed by ${(m.changeDelta * 100).toFixed(1)}%)` : '';
        return `Market: ${m.title} (Current Yes Price: ${(m.probability * 100).toFixed(1)}%)${changeStr}`;
    }),
    ...events.map(e => `Event: ${e}`)
  ].join('\n');

  const prompt = `
  Input Data for Date ${date}:
  ${eventsList}

  **REQUIRED ANALYSIS TASKS:**

  1. **Economic & Public Summary:** Provide a 2-sentence summary of what the public currently thinks about this event and its specific impact on the broader economy.
  2. **Asset-Specific Impact:**
     if a specific coin is targeted, please state the effect on the coin, but also discuss the impact on major coins such as
     * **Bitcoin (BTC):** State if it is [Bullish/Bearish/Neutral] + [Intensity].
     * **Ethereum (ETH):** State if it is [Bullish/Bearish/Neutral] + [Intensity].
  3. **Timeline Breakdown:**
     * **Short-Term Effects:** List the likely market reactions and volatility expectations for the next week.
     * **Mid-Term Effects:** List how this catalyst will "settle" or influence the market over the next quarter.
  
  THE FINAL VERDICT AT THE END: OVERALL IMPACT: please ONLY use one word to state the intensity (slightly, extremely) and one word, bullish, bearish, or neutral.
  
  **Format Requirements:**
  Please list every category above separately using clear headers. Use bold text for the Sentiment and Intensity keywords. Please be more concise if possible.
  `;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4-turbo", 
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
    }

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    
    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
      throw new Error('Invalid response format: missing choices array');
    }
    
    const text = data.choices[0]?.message?.content;
    if (!text || typeof text !== 'string') {
      throw new Error('Invalid response format: missing or invalid content');
    }
    
    const lowerText = text.toLowerCase();
    let verdict: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';
    if (lowerText.includes('overall impact:') || lowerText.includes('final verdict')) {
        if (lowerText.includes('bullish')) verdict = 'BULLISH';
        else if (lowerText.includes('bearish')) verdict = 'BEARISH';
    }

    const summary = text.split('**Asset-Specific Impact:**')[0]?.replace('**Economic & Public Summary:**', '').trim() || "See full details.";
    
    return {
      summary: summary.substring(0, 200) + "...",
      assetImpact: "Available in full report", 
      shortTerm: "Available in full report",
      midTerm: "Available in full report",
      verdict,
      intensity: "Standard",
      rawText: text,
      timestamp: Date.now()
    };
  } catch (error) {
    console.error("AI Analysis Failed", error);
    throw error;
  }
};

// --- Components ---

const DayCell = ({ 
  day, 
  data, 
  onClick, 
  isCurrentMonth,
  isCrossAnalysisMode,
  isSelected,
  onMouseDown,
  onMouseEnter,
  onMouseUp,
  eventMatchesFilters,
  isToday,
  hasActiveFilters
}: { 
  day: number, 
  data?: DayData, 
  onClick: () => void,
  isCurrentMonth: boolean,
  isCrossAnalysisMode?: boolean,
  isSelected?: boolean,
  onMouseDown?: () => void,
  onMouseEnter?: () => void,
  onMouseUp?: () => void,
  eventMatchesFilters?: (tags: string[] | undefined) => boolean,
  isToday?: boolean,
  hasActiveFilters?: boolean
}) => {
  if (!isCurrentMonth) return <div className="bg-slate-50/50 border border-slate-100 h-24 sm:h-28 md:h-32 lg:h-36"></div>;

  let bgClass = "bg-white hover:bg-slate-50";
  let borderClass = "border-slate-200";
  
  // Color coding based on AI Verdict
  if (data?.analysis) {
    if (data.analysis.verdict === 'BULLISH') {
      bgClass = "bg-emerald-50 hover:bg-emerald-100";
      borderClass = "border-emerald-200";
    } else if (data.analysis.verdict === 'BEARISH') {
      bgClass = "bg-rose-50 hover:bg-rose-100";
      borderClass = "border-rose-200";
    }
  }

  // For calendar preview: show ALL prediction markets (don't filter by catalyst)
  // This prioritizes showing all markets in the preview, not just one per catalyst
  // The detail modal still shows all markets
  const allMarkets = data?.markets || [];
  
  // For calendar preview: when filters are active, filter out non-matching events
  // For expanded view: show all events (handled separately in the modal)
  const previewMarkets = hasActiveFilters && eventMatchesFilters
    ? allMarkets.filter(m => eventMatchesFilters(m.tags))
    : allMarkets;
  
  // Manual events have no tags, so when filters are active, hide them in preview
  // (They're still shown in the detail modal)
  const previewManualEvents = hasActiveFilters
    ? [] // Hide manual events when filters are active
    : (data?.manualEvents || []);
  
  const hasContent = (data?.markets.length || 0) > 0 || (data?.manualEvents.length || 0) > 0 || (data?.panewsEvents.length || 0) > 0;
  const hasMoreMarkets = (data?.markets.length || 0) > MAX_PREVIEW_EVENTS; // Use original count for "+ more..." indicator
  
  // PA News events preview (filtered if filters active)
  const previewPANews = hasActiveFilters && eventMatchesFilters
    ? (data?.panewsEvents || []).filter(e => eventMatchesFilters(e.tags))
    : (data?.panewsEvents || []);

  const handleClick = () => {
    // Only handle click if not in cross analysis mode (normal behavior)
    // In cross analysis mode, selection is handled by mouse up
    if (!isCrossAnalysisMode) {
      onClick();
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (isCrossAnalysisMode) {
      // Prevent text selection during drag
      e.preventDefault();
      if (onMouseDown) {
        onMouseDown();
      }
    }
  };

  const handleMouseEnter = () => {
    if (isCrossAnalysisMode && onMouseEnter) {
      onMouseEnter();
    }
  };

  const handleMouseUp = () => {
    if (isCrossAnalysisMode && onMouseUp) {
      onMouseUp();
    }
  };

  // Selection overlay styling
  const selectionOverlay = isSelected ? (
    <div className="absolute inset-0 border-2 border-blue-500 bg-blue-100/30 z-[5] pointer-events-none" />
  ) : null;

  return (
    <div 
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onMouseUp={handleMouseUp}
      role={isCrossAnalysisMode ? "checkbox" : "button"}
      aria-label={isCrossAnalysisMode ? `Select date ${day}` : `View events for ${day}`}
      aria-pressed={isSelected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick();
        }
      }}
      className={`relative h-24 sm:h-28 md:h-32 lg:h-36 border ${borderClass} ${bgClass} p-1 sm:p-1.5 md:p-2 transition-all ${isCrossAnalysisMode ? 'cursor-crosshair select-none' : 'cursor-pointer'} flex flex-col gap-0.5 sm:gap-1 overflow-hidden group z-0 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
      style={{ isolation: 'isolate', ...(isCrossAnalysisMode ? { userSelect: 'none' as const } : {}) }}
    >
      {selectionOverlay}
      {/* Today Indicator - Ring around the cell */}
      {isToday && (
        <div className="absolute inset-0 border-2 border-amber-500 rounded-sm z-[1] pointer-events-none" style={{ borderRadius: '0.125rem' }} />
      )}
      <div className="flex justify-between items-start flex-shrink-0 relative z-[2]">
        <div className="flex items-center gap-0.5 sm:gap-1">
            {/* Today Badge */}
            {isToday ? (
              <span className="text-xs sm:text-sm font-bold bg-amber-500 text-white rounded-full w-5 h-5 sm:w-6 sm:h-6 flex items-center justify-center shadow-md shadow-amber-200">
                {day}
              </span>
            ) : (
              <span className={`text-xs sm:text-sm font-semibold ${data?.analysis ? 'text-slate-800' : 'text-slate-500'}`}>{day}</span>
            )}
            
            {/* Stale Analysis Indicator */}
            {data?.hasStaleAnalysis && (
                <div title="New Data Available" className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-orange-500 animate-pulse"></div>
            )}
        </div>

        {data?.analysis && (
          <div className={`p-0.5 sm:p-1 rounded-full flex-shrink-0 ${data.analysis.verdict === 'BULLISH' ? 'bg-emerald-200' : data.analysis.verdict === 'BEARISH' ? 'bg-rose-200' : 'bg-slate-200'}`}>
            {data.analysis.verdict === 'BULLISH' ? <TrendingUp size={10} className="sm:w-3 sm:h-3 text-emerald-700"/> : 
             data.analysis.verdict === 'BEARISH' ? <TrendingDown size={10} className="sm:w-3 sm:h-3 text-rose-700"/> : 
             <Activity size={10} className="sm:w-3 sm:h-3 text-slate-700"/>}
          </div>
        )}
      </div>
      
      <div className="flex flex-col gap-0.5 sm:gap-1 mt-0.5 sm:mt-1 flex-1 min-h-0 overflow-hidden">
        {data?.hasSignificantChange && (
            <div className="flex items-center gap-0.5 sm:gap-1 text-[8px] sm:text-[9px] font-bold text-amber-600 px-0.5 sm:px-1 flex-shrink-0">
                <AlertTriangle size={7} className="sm:w-2 sm:h-2" /> Big Change
            </div>
        )}

        <div className="flex flex-col gap-0.5 sm:gap-1 flex-1 min-h-0 overflow-hidden">
          {/* Calendar Preview: Prioritize prediction markets, show other events only if space allows */}
          {/* Show all prediction markets first (up to MAX_PREVIEW_EVENTS) */}
          {previewMarkets.slice(0, MAX_PREVIEW_EVENTS).map((m) => {
            // Apply BTC impact background color
            const bgColorClass = m.btcImpact === 'bullish' 
              ? 'bg-emerald-100/80 border-emerald-200' 
              : m.btcImpact === 'bearish' 
              ? 'bg-rose-100/80 border-rose-200' 
              : 'bg-slate-100/80 border-slate-200';
            
            return (
              <div 
                key={m.id} 
                className={`flex items-center gap-0.5 sm:gap-1 text-[9px] sm:text-[10px] ${bgColorClass} px-1 sm:px-1.5 py-0.5 rounded border truncate text-slate-700 flex-shrink-0`}
              >
                <span className={`font-bold flex-shrink-0 ${m.changeDelta && Math.abs(m.changeDelta) > SIGNIFICANT_CHANGE_THRESHOLD ? 'text-amber-600' : 'text-blue-600'}`}>
                    {(m.probability * 100).toFixed(0)}%
                </span>
                <span className="truncate min-w-0">{m.title}</span>
              </div>
            );
          })}
          
          {/* Only show manual events if we haven't reached MAX_PREVIEW_EVENTS with markets */}
          {previewMarkets.length < MAX_PREVIEW_EVENTS && previewManualEvents.slice(0, MAX_PREVIEW_EVENTS - previewMarkets.length).map((e, idx) => (
            <div 
              key={idx} 
              className="flex items-center gap-0.5 sm:gap-1 text-[9px] sm:text-[10px] bg-amber-50 px-1 sm:px-1.5 py-0.5 rounded border border-amber-100 truncate text-amber-800 flex-shrink-0"
            >
               <span className="truncate min-w-0">📢 {e}</span>
            </div>
          ))}
          
          {/* Only show PA News events if we still have space after markets and manual events */}
          {previewMarkets.length + previewManualEvents.length < MAX_PREVIEW_EVENTS && previewPANews.slice(0, MAX_PREVIEW_EVENTS - previewMarkets.length - previewManualEvents.length).map((e) => (
            <div 
              key={e.id} 
              className="flex items-center gap-0.5 sm:gap-1 text-[9px] sm:text-[10px] bg-blue-50 px-1 sm:px-1.5 py-0.5 rounded border border-blue-100 truncate text-blue-800 flex-shrink-0"
            >
              <span className="truncate min-w-0">{e.title}</span>
              <span className="flex-shrink-0">🔗</span>
            </div>
          ))}
        </div>
        
        {hasContent && hasMoreMarkets && (
           <div className="mt-auto pt-0.5 sm:pt-1 flex-shrink-0">
             <span className="text-[9px] sm:text-[10px] text-slate-400 pl-0.5 sm:pl-1">+ more...</span>
           </div>
        )}
      </div>
      
      {data?.hasStaleAnalysis && (
          <div className="absolute bottom-1 right-1">
             <RefreshCw size={10} className="text-orange-400" />
          </div>
      )}
    </div>
  );
};

export default function CryptoCalendar() {
  // --- State ---
  const [currentDate, setCurrentDate] = useState(new Date());
  const [user, setUser] = useState<User | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState<'import' | 'debug'>('import');
  
  // Cross Analysis State
  const [isCrossAnalysisMode, setIsCrossAnalysisMode] = useState(false);
  const [selectedDays, setSelectedDays] = useState<Set<string>>(new Set());
  const [isDragging, setIsDragging] = useState(false);
  const [dragStartDate, setDragStartDate] = useState<string | null>(null);
  const [dragInitialState, setDragInitialState] = useState<boolean>(false); // Track if start date was initially selected
  const [mouseDownDate, setMouseDownDate] = useState<string | null>(null); // Track where mouse was pressed
  const [hasDragged, setHasDragged] = useState(false); // Track if mouse moved (drag vs click)
  const [crossAnalysisResult, setCrossAnalysisResult] = useState<string | null>(null);
  const [isRunningCrossAnalysis, setIsRunningCrossAnalysis] = useState(false);
  const [crossAnalysisTab, setCrossAnalysisTab] = useState<'analysis' | 'chat'>('analysis');
  const [chatQuery, setChatQuery] = useState('');
  const [isCrossAnalysisCollapsed, setIsCrossAnalysisCollapsed] = useState(false);
  const [uploadedImage, setUploadedImage] = useState<File | null>(null); // Screenshot/image for Chat tab
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null); // Object URL for preview
  
  // Data State
  const [markets, setMarkets] = useState<MarketData[]>([]);
  const [manualEvents, setManualEvents] = useState<Record<string, string[]>>({}); 
  const [panewsEvents, setPANewsEvents] = useState<Record<string, PANewsEvent[]>>({});
  const [analyses, setAnalyses] = useState<Record<string, AnalysisResult>>({});
  const [lastMarketUpdate, setLastMarketUpdate] = useState<number | null>(null); 
  
  // Settings State
  const [openAIKey, setOpenAIKey] = useState('');
  const [jsonInput, setJsonInput] = useState('');
  
  // BTC Impact Classification State
  const [isClassifyingBTCImpact, setIsClassifyingBTCImpact] = useState(false);
  const [btcImpactProgress, setBtcImpactProgress] = useState({ current: 0, total: 0 });
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [importStatus, setImportStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [panewsImportStatus, setPANewsImportStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  
  // Filter State
  const [activeFilters, setActiveFilters] = useState<Set<FilterType>>(new Set());
  const [showFilters, setShowFilters] = useState(false);

  // --- Auth & Init ---
  useEffect(() => {
    signInAnonymously(auth);
    const unsubscribe = onAuthStateChanged(auth, setUser);
    return () => unsubscribe();
  }, []);

  // --- Firestore Sync ---
  useEffect(() => {
    if (!user) return;

    // Load Data Collections
    const marketsUnsub = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'markets'), (snap) => {
      const loadedMarkets: MarketData[] = [];
      let maxLastUpdated = 0;
      snap.forEach(doc => {
        const data = doc.data() as MarketData;
        loadedMarkets.push(data);
        // Track the most recent lastUpdated timestamp
        if (data.lastUpdated && data.lastUpdated > maxLastUpdated) {
          maxLastUpdated = data.lastUpdated;
        }
      });
      setMarkets(loadedMarkets);
      if (maxLastUpdated > 0) {
        setLastMarketUpdate(maxLastUpdated);
        console.log('Market update timestamp:', new Date(maxLastUpdated).toLocaleString());
      } else if (loadedMarkets.length > 0) {
        // Fallback: use current time if no lastUpdated found (for markets without timestamp)
        console.warn('Markets found but no lastUpdated timestamps. Using current time.');
        setLastMarketUpdate(Date.now());
      }
    }, (err) => console.error("Market fetch error", err));

    const eventsUnsub = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'manual_events'), (snap) => {
      const events: Record<string, string[]> = {};
      snap.forEach(doc => {
        events[doc.id] = doc.data().events;
      });
      setManualEvents(events);
    }, (err) => console.error("Events fetch error", err));

    const panewsUnsub = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'pa_events'), (snap) => {
      const events: Record<string, PANewsEvent[]> = {};
      snap.forEach(doc => {
        const data = doc.data();
        if (data.events && Array.isArray(data.events)) {
          events[doc.id] = data.events as PANewsEvent[];
        }
      });
      setPANewsEvents(events);
    }, (err) => console.error("PA News events fetch error", err));

    const analysesUnsub = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'analyses'), (snap) => {
      const loadedAnalyses: Record<string, AnalysisResult> = {};
      snap.forEach(doc => {
        loadedAnalyses[doc.id] = doc.data() as AnalysisResult;
      });
      setAnalyses(loadedAnalyses);
      setLoading(false);
    }, (err) => console.error("Analysis fetch error", err));

    return () => {
      marketsUnsub();
      eventsUnsub();
      panewsUnsub();
      analysesUnsub();
    };
  }, [user]);

  // Cleanup image preview URL on unmount or when image changes
  useEffect(() => {
    return () => {
      if (imagePreviewUrl) {
        URL.revokeObjectURL(imagePreviewUrl);
      }
    };
  }, [imagePreviewUrl]);

  // --- Actions ---

  const handleImportN8n = async () => {
    if (!user) {
      alert("Please wait for authentication to complete.");
      return;
    }
    if (!jsonInput.trim()) {
      alert("Please enter JSON data to import.");
      setImportStatus('error');
      return;
    }
    
    setImportStatus('loading');
    
    try {
      const parsed = JSON.parse(jsonInput);
      if (!Array.isArray(parsed)) {
        throw new Error("Input must be a JSON Array");
      }
      if (parsed.length === 0) {
        throw new Error("Array cannot be empty");
      }

      const batch = writeBatch(db);
      let count = 0;
      let skipped = 0;
      let firstValidDate: Date | null = null;
      let updateCount = 0;

      parsed.forEach((item: Record<string, unknown>) => {
          if (count >= MAX_BATCH_SIZE) return; 

          const normalized = normalizeMarketData(item);
          if (normalized && normalized.id && normalized.resolveDate) {
              const marketRef = doc(db, 'artifacts', appId, 'public', 'data', 'markets', normalized.id);
              
              // === SMART CHANGE DETECTION ===
              // Lookup existing data from our local state (avoiding extra read costs)
              const existingMarket = markets.find(m => m.id === normalized.id);
              
              const newProbability = normalized.probability || 0;
              let previousProbability = existingMarket?.probability;
              let changeDelta = 0;
              let lastUpdated = Date.now(); // Always update timestamp on touch

              if (existingMarket) {
                  // If it already exists, calculate delta
                  changeDelta = newProbability - (existingMarket.probability || 0);
                  // Only update previousProbability if the change is non-zero
                  if (Math.abs(changeDelta) > 0.001) {
                       previousProbability = existingMarket.probability;
                       updateCount++;
                  } else {
                       // No real change, preserve old values
                       previousProbability = existingMarket.previousProbability;
                       changeDelta = existingMarket.changeDelta || 0;
                       // We can choose NOT to update timestamp if value didn't change
                       // but for "Update Analysis" logic, we might want to know when we last confirmed the data
                  }
              }

              // Apply the smart fields
              const finalData = {
                  ...normalized,
                  lastUpdated,
                  previousProbability: previousProbability !== undefined ? previousProbability : null,
                  changeDelta: Number(changeDelta.toFixed(4)) // Clean float
              };

              batch.set(marketRef, finalData, { merge: true });
              count++;
              
              if (!firstValidDate) {
                  firstValidDate = parseDate(normalized.resolveDate as string);
              }
          } else {
              skipped++;
          }
      });
      
      await batch.commit();
      setImportStatus('success');
      setJsonInput('');
      
      if (firstValidDate) {
          setCurrentDate(firstValidDate as Date);
          alert(`Import Successful!\n\nImported/Updated ${count} items.\nDetected Changes in ${updateCount} items.\nSkipped ${skipped}.\n\nJumping calendar to: ${toLocalISOString(firstValidDate as Date)}`);
      } else {
          alert(`Import Successful.\nImported: ${count}, Skipped: ${skipped}`);
      }

      setTimeout(() => setImportStatus('idle'), 3000);
      
    } catch (e) {
      console.error("Import error:", e);
      const errorMessage = e instanceof Error ? e.message : "Unknown error occurred";
      alert(`Import failed: ${errorMessage}`);
      setImportStatus('error');
      setTimeout(() => setImportStatus('idle'), 3000);
    }
  };

  const simulateN8nData = async () => {
    if (!user) return;
    const mocks = generateMockData();
    const batch = writeBatch(db); 
    
    mocks.forEach(m => {
        const ref = doc(db, 'artifacts', appId, 'public', 'data', 'markets', m.id);
        batch.set(ref, m, { merge: true });
    });
    
    await batch.commit();
    setImportStatus('success');
    setTimeout(() => setImportStatus('idle'), 3000);
  };

  /**
   * Sync PA News Events - Manual trigger
   * 
   * Calls the backend ingestion function (currently runs client-side).
   * TODO: Update to call Firebase Cloud Function when backend is deployed.
   */
  const syncPANewsEvents = async () => {
    if (!user) {
      alert("Please wait for authentication to complete.");
      return;
    }
    
    setPANewsImportStatus('loading');
    
    try {
      // TODO: When backend is deployed, replace with:
      // const ingestPanewsEvents = httpsCallable(functions, 'ingestPanewsEvents');
      // const result = await ingestPanewsEvents({});
      
      // For now, call the function directly (runs client-side)
      const result = await ingestPanewsEvents(db, appId, {
        // TODO: Add date range picker in UI
        // startDate: userSelectedStartDate,
        // endDate: userSelectedEndDate
      });
      
      setPANewsImportStatus('success');
      
      // Show detailed success message
      const message = result.errors.length > 0
        ? `Sync completed with ${result.errors.length} warning(s):\n\n` +
          `• Days updated: ${result.daysUpdated}\n` +
          `• Events inserted: ${result.eventsInserted}\n` +
          `• Errors: ${result.errors.slice(0, 3).join(', ')}${result.errors.length > 3 ? '...' : ''}`
        : `Sync Successful!\n\n` +
          `• Days updated: ${result.daysUpdated}\n` +
          `• Events inserted: ${result.eventsInserted}`;
      
      alert(message);
      
      // Log errors to console for debugging
      if (result.errors.length > 0) {
        console.warn('PA News sync completed with errors:', result.errors);
      }
      
      setTimeout(() => setPANewsImportStatus('idle'), 3000);
      
    } catch (e) {
      console.error("PA News sync error:", e);
      const errorMessage = e instanceof Error ? e.message : "Unknown error occurred";
      alert(`PA News sync failed: ${errorMessage}`);
      setPANewsImportStatus('error');
      setTimeout(() => setPANewsImportStatus('idle'), 3000);
    }
  };

  const clearAllData = async () => {
    if(!user || !confirm("Are you sure? This will delete all markets, events, and analyses.")) return;
    const batch = writeBatch(db);
    markets.forEach(m => batch.delete(doc(db, 'artifacts', appId, 'public', 'data', 'markets', m.id)));
    // Also clear analyses ideally, but limited batch size. For demo we clear markets.
    await batch.commit();
    alert("Data cleared.");
  };

  const addManualEvent = async (date: string, text: string) => {
    if (!user) {
      alert("Please wait for authentication to complete.");
      return;
    }
    if (!text.trim()) {
      return;
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error("Invalid date format:", date);
      return;
    }
    
    try {
    const currentEvents = manualEvents[date] || [];
      const newEvents = [...currentEvents, text.trim()];
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'manual_events', date), { events: newEvents });
    } catch (e) {
      console.error("Error adding manual event:", e);
      alert("Failed to add event. Please try again.");
    }
  };

  const removeManualEvent = async (date: string, index: number) => {
    if (!user) {
      alert("Please wait for authentication to complete.");
      return;
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error("Invalid date format:", date);
      return;
    }
    if (index < 0 || index >= (manualEvents[date]?.length || 0)) {
      console.error("Invalid event index:", index);
      return;
    }
    
    try {
    const currentEvents = manualEvents[date] || [];
    const newEvents = currentEvents.filter((_, i) => i !== index);
    if (newEvents.length === 0) {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'manual_events', date));
    } else {
        await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'manual_events', date), { events: newEvents });
      }
    } catch (e) {
      console.error("Error removing manual event:", e);
      alert("Failed to remove event. Please try again.");
    }
  };

  const runAnalysis = async (date: string, dateMarkets: MarketData[], dateEvents: string[], datePANews: PANewsEvent[] = []) => {
    if (!openAIKey || !openAIKey.trim()) {
        alert("Please enter your OpenAI API Key in settings first.");
        return;
    }
    if (!user) {
        alert("Please wait for authentication to complete.");
        return;
    }
    if (dateMarkets.length === 0 && dateEvents.length === 0 && datePANews.length === 0) {
        alert("No events or markets to analyze for this date.");
        return;
    }
    
    setIsAnalysing(true);
    try {
        // Include PA News events in analysis
        const panewsEventsList = datePANews.map(e => `PA News: ${e.title}${e.tags.length > 0 ? ` [Tags: ${e.tags.join(', ')}]` : ''}`);
        const allEvents = [...dateEvents, ...panewsEventsList];
        const result = await analyzeDay(date, dateMarkets, allEvents, openAIKey);
        await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'analyses', date), result);
    } catch (e) {
        console.error("Analysis error:", e);
        const errorMessage = e instanceof Error ? e.message : "Unknown error occurred";
        alert(`Analysis failed: ${errorMessage}. Check API Key or console.`);
    } finally {
        setIsAnalysing(false);
    }
  };

  // --- Cross Analysis Functions ---
  
  const toggleCrossAnalysisMode = () => {
    setIsCrossAnalysisMode(prev => {
      if (prev) {
        // Exiting mode - clear selection
        setSelectedDays(new Set());
        setCrossAnalysisResult(null);
        setChatQuery('');
        setCrossAnalysisTab('analysis');
      }
      return !prev;
    });
  };

  const handleDaySelect = (dateStr: string) => {
    if (!isCrossAnalysisMode) return;
    
    setSelectedDays(prev => {
      const newSet = new Set(prev);
      if (newSet.has(dateStr)) {
        newSet.delete(dateStr);
      } else {
        newSet.add(dateStr);
      }
      return newSet;
    });
  };

  const handleMouseDown = (dateStr: string) => {
    if (!isCrossAnalysisMode) return;
    setMouseDownDate(dateStr);
    setHasDragged(false);
    setDragStartDate(dateStr);
    // Track initial state
    setSelectedDays(prev => {
      const wasSelected = prev.has(dateStr);
      setDragInitialState(wasSelected);
      return prev; // Don't toggle yet - wait to see if it's a click or drag
    });
  };

  const handleMouseEnter = (dateStr: string) => {
    if (!isCrossAnalysisMode || !mouseDownDate) return;
    
    // Validate date strings
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^\d{4}-\d{2}-\d{2}$/.test(mouseDownDate)) {
      return;
    }
    
    // If we enter a different cell, it's a drag
    if (dateStr !== mouseDownDate && !isDragging) {
      setIsDragging(true);
      setHasDragged(true);
      // Now toggle the start date and start drag selection
      setSelectedDays(prev => {
        const newSet = new Set(prev);
        if (dragInitialState) {
          newSet.delete(mouseDownDate);
        } else {
          newSet.add(mouseDownDate);
        }
        return newSet;
      });
    }
    
    // Continue drag selection if we're dragging
    if (isDragging && dragStartDate) {
      try {
      // Select all dates between dragStartDate and current date
      const start = parseDate(dragStartDate);
      const end = parseDate(dateStr);
      const dates: string[] = [];
      
      let current = new Date(start);
      let endDate = new Date(end);
      
      // Swap if start > end
      if (current > endDate) {
        const temp = current;
        current = endDate;
        endDate = temp;
      }
      
        // Limit range to prevent performance issues (max 365 days)
        const maxDays = 365;
        let dayCount = 0;
        
        while (current <= endDate && dayCount < maxDays) {
        dates.push(toLocalISOString(new Date(current)));
        current.setDate(current.getDate() + 1);
          dayCount++;
      }
      
      setSelectedDays(prev => {
        const newSet = new Set(prev);
        // Determine if we should add or remove based on initial state
        const shouldAdd = !dragInitialState;
        dates.forEach(d => {
          if (shouldAdd) {
            newSet.add(d);
          } else {
            newSet.delete(d);
          }
        });
        return newSet;
      });
      } catch (e) {
        console.error("Error in drag selection:", e);
      }
    }
  };

  const handleMouseUp = (dateStr: string) => {
    if (!isCrossAnalysisMode || !mouseDownDate) return;
    
    // If it was a click (no drag), toggle the date
    if (!hasDragged && dateStr === mouseDownDate) {
      handleDaySelect(dateStr);
    }
    
    // Reset drag state
    setIsDragging(false);
    setMouseDownDate(null);
    setDragStartDate(null);
    setHasDragged(false);
    setDragInitialState(false);
  };

  const clearSelection = () => {
    // Clean up image object URL if present
    if (imagePreviewUrl) {
      URL.revokeObjectURL(imagePreviewUrl);
    }
    setSelectedDays(new Set());
    setCrossAnalysisResult(null);
    setUploadedImage(null);
    setImagePreviewUrl(null);
  };

  const runCrossAnalysis = async () => {
    if (selectedDays.size === 0) return;
    if (!openAIKey) {
      alert("Please enter your OpenAI API Key in settings first.");
      return;
    }
    
    // For chat mode, require a query
    if (crossAnalysisTab === 'chat' && !chatQuery.trim()) {
      return;
    }

    setIsRunningCrossAnalysis(true);
    setCrossAnalysisResult(null);

    try {
      // Aggregate events by date
      const dates = Array.from(selectedDays).sort();
      const eventsByDate: Record<string, { markets: MarketData[], manualEvents: string[], panewsEvents: PANewsEvent[] }> = {};
      
      dates.forEach(dateStr => {
        // Get all markets and events for this date
        const allDayMarkets = markets.filter(m => m.resolveDate === dateStr);
        const allDayEvents = manualEvents[dateStr] || [];
        const allDayPANews = panewsEvents[dateStr] || [];
        
        // Apply filters if active
        let filteredMarkets: MarketData[];
        let filteredManualEvents: string[];
        let filteredPANews: PANewsEvent[];
        
        if (activeFilters.size === 0) {
          // No filters: include all events
          filteredMarkets = allDayMarkets;
          filteredManualEvents = allDayEvents;
          filteredPANews = allDayPANews;
        } else {
          // Filters active: only include matching events
          filteredMarkets = allDayMarkets.filter(m => eventMatchesFilters(m.tags));
          // Manual events have no tags, so exclude them when filters are active
          filteredManualEvents = [];
          // PA News events: filter by tags
          filteredPANews = allDayPANews.filter(e => eventMatchesFilters(e.tags));
        }
        
        eventsByDate[dateStr] = {
          markets: filteredMarkets,
          manualEvents: filteredManualEvents,
          panewsEvents: filteredPANews
        };
      });

      // Build payload (only include dates that have at least one event after filtering)
      const filteredDates = dates.filter(dateStr => {
        const dayData = eventsByDate[dateStr];
        return dayData.markets.length > 0 || dayData.manualEvents.length > 0 || dayData.panewsEvents.length > 0;
      });

      // Fetch live Bitcoin price (non-blocking - returns null on failure)
      const bitcoinPrice = await fetchLiveBitcoinPrice();

      // Convert uploaded image to base64 if present (only for Chat tab)
      let imageBase64: string | undefined = undefined;
      if (uploadedImage && crossAnalysisTab === 'chat') {
        try {
          imageBase64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result === 'string') {
                resolve(reader.result);
              } else {
                reject(new Error('Failed to read image as base64'));
              }
            };
            reader.onerror = reject;
            reader.readAsDataURL(uploadedImage);
          });
        } catch (error) {
          console.warn('Failed to convert image to base64:', error);
          // Continue without image if conversion fails
        }
      }

      const payload = {
        dates: filteredDates,
        eventsByDate,
        liveMarketData: bitcoinPrice ? { bitcoin: bitcoinPrice } : undefined,
        imageContext: imageBase64
      };

      // Call cross analysis function with mode and optional userQuery
      const mode = crossAnalysisTab;
      const userQuery = crossAnalysisTab === 'chat' ? chatQuery.trim() : undefined;
      const result = await analyzeCrossDays(payload, openAIKey, mode, userQuery);
      setCrossAnalysisResult(result);
    } catch (e) {
      console.error("Cross Analysis failed", e);
      alert("Cross Analysis failed. Check API Key or console.");
    } finally {
      setIsRunningCrossAnalysis(false);
    }
  };

  // Cross Analysis AI function (aggregates data and calls AI)
  const analyzeCrossDays = async (
    payload: { 
      dates: string[], 
      eventsByDate: Record<string, { markets: MarketData[], manualEvents: string[], panewsEvents: PANewsEvent[] }>,
      liveMarketData?: { bitcoin: BitcoinPriceData },
      imageContext?: string // base64 image data
    },
    apiKey: string,
    mode: 'analysis' | 'chat' = 'analysis',
    userQuery?: string
  ): Promise<string> => {
    if (!apiKey) throw new Error("OpenAI API Key is missing");

    // Build events list for all selected days
    const eventsList = payload.dates.map(date => {
      const dayData = payload.eventsByDate[date];
      const dayEvents = [
        ...dayData.markets.map(m => {
          const changeStr = m.changeDelta ? ` (Changed by ${(m.changeDelta * 100).toFixed(1)}%)` : '';
          const tagsStr = m.tags && m.tags.length > 0 ? ` [Tags: ${m.tags.join(', ')}]` : '';
          return `Market: ${m.title} (Current Yes Price: ${(m.probability * 100).toFixed(1)}%)${changeStr}${tagsStr}`;
        }),
        ...dayData.manualEvents.map(e => `Manual Event: ${e}`),
        ...dayData.panewsEvents.map(e => {
          const tagsStr = e.tags.length > 0 ? ` [Tags: ${e.tags.join(', ')}]` : '';
          return `PA News: ${e.title}${tagsStr}`;
        })
      ].join('\n');
      return `Date ${date}:\n${dayEvents}`;
    }).join('\n\n');

    let systemPrompt: string;
    let userMessage: string;

    if (mode === 'chat') {
      // Chat mode: specialized contextual analyst
      systemPrompt = `You are a specialized financial and crypto market analyst.

Your task is to analyze selected calendar events across multiple dates,
focusing on Bitcoin and macroeconomic implications.

You must:
- Reason temporally (earlier events can affect later ones)
- Weigh importance (some events dominate others)
- Consider current macroeconomic climate and historical patterns
- Avoid surface-level summaries

You are NOT a news reporter.
You are NOT speculative or promotional.

When responding:
- Anchor your analysis in the provided events and dates
- Use the user's question to guide emphasis and framing
- Do not invent events or data not present
- Clearly explain causal relationships and tradeoffs

Be concise but analytical.
Avoid unnecessary hedging.
Assume the user understands markets.

If uncertainty exists, explain WHY.
If one event dominates, say so explicitly.`;

      // Build context with optional Bitcoin price data
      let contextText = eventsList;
      if (payload.liveMarketData?.bitcoin) {
        const btc = payload.liveMarketData.bitcoin;
        contextText = `Live Market Context:
Bitcoin Price: $${btc.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${btc.change24hPct >= 0 ? '+' : ''}${btc.change24hPct.toFixed(2)}% 24h)
Source: ${btc.source} (fetched at ${new Date(btc.fetchedAt).toLocaleString()})

${eventsList}`;
      }

      userMessage = `Context:

${contextText}

User Question:

${userQuery}

Instruction:

Answer the user's question using the context above.`;
    } else {
      // Analysis mode: existing structured analysis
      systemPrompt = `You are a specialized financial and crypto macro analysis assistant.

Your task is to analyze multiple days of events together, not independently.

You must:
- Reason temporally (earlier vs later events)
- Identify causal chains and reinforcement effects
- Weigh relative importance (some days matter more than others)
- Consider current macroeconomic climate and historical patterns
- Focus on Bitcoin and broader crypto market impact

Avoid surface-level summaries.
Do not restate events verbatim.
Do not hedge excessively.

You are allowed to take time internally to reason carefully,
but your final response must be concise and decisive.

When analyzing the selected days:
1. Identify the dominant macro themes across all days
2. Determine whether events reinforce or contradict each other
3. Evaluate whether later events override earlier signals
4. Consider second-order effects (policy → liquidity → risk assets)
5. Compare market expectations vs catalyst direction
6. Synthesize into a single coherent outlook for Bitcoin

Your response MUST follow this exact structure:

SUMMARY:
- 3–5 bullet points
- Each bullet = one key insight
- No filler language

TEMPORAL ASSESSMENT:
- 2–3 sentences explaining how the timing of events changes impact

FINAL JUDGMENT:
- Intensity: ONE word only (e.g. slightly, moderately, strongly, extremely)
- Direction: ONE word only (bullish | bearish | neutral)

Example:
Intensity: moderately
Direction: bullish

Additional rules:
- Do not include probabilities in the final judgment
- Do not mention prediction markets explicitly
- Do not say "this is not financial advice"
- Do not ask follow-up questions
- Be assertive but reasoned`;

      // Build context with optional Bitcoin price data
      let contextText = eventsList;
      if (payload.liveMarketData?.bitcoin) {
        const btc = payload.liveMarketData.bitcoin;
        contextText = `Live Market Context:
Bitcoin Price: $${btc.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${btc.change24hPct >= 0 ? '+' : ''}${btc.change24hPct.toFixed(2)}% 24h)
Source: ${btc.source} (fetched at ${new Date(btc.fetchedAt).toLocaleString()})

${eventsList}`;
      }

      userMessage = `Analyze the following events across the selected dates:

${contextText}

Provide your analysis following the required format.`;
    }

    try {
      // Build user message content - support multimodal (text + image) if image is present
      let userContent: string | Array<{ type: "text" | "image_url", text?: string, image_url?: { url: string } }>;
      
      if (payload.imageContext) {
        // Multimodal: text + image
        userContent = [
          { type: "text", text: userMessage },
          { type: "image_url", image_url: { url: payload.imageContext } }
        ];
      } else {
        // Text-only: existing format
        userContent = userMessage;
      }

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: payload.imageContext ? "gpt-4o" : "gpt-4-turbo", // Use gpt-4o for multimodal, gpt-4-turbo for text-only
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
          ],
          temperature: 0.7
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      
      if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
        throw new Error('Invalid response format: missing choices array');
      }
      
      const content = data.choices[0]?.message?.content;
      if (!content || typeof content !== 'string') {
        throw new Error('Invalid response format: missing or invalid content');
      }
      
      return content;
    } catch (error) {
      console.error("Cross Analysis Failed", error);
      throw error;
    }
  };

  // --- Filter Functions ---
  
  /**
   * Check if an event matches any of the active filters
   * Manual events (no tags) never match filters
   * Comparison is case-insensitive to handle tag variations
   */
  const eventMatchesFilters = (tags: string[] | undefined): boolean => {
    if (activeFilters.size === 0) return true; // No filters = show all
    if (!tags || tags.length === 0) return false; // Manual events don't match
    
    // Normalize tags to lowercase for comparison (tags are already lowercase from normalization, but be safe)
    const normalizedTags = tags.map(t => String(t).toLowerCase().trim()).filter(t => t.length > 0);
    
    // Check if any tag intersects with any active filter's tag group (case-insensitive exact match)
    for (const filterType of activeFilters) {
      const filterTags = FILTER_TAG_GROUPS[filterType];
      const normalizedFilterTags = (filterTags as readonly string[]).map(ft => ft.toLowerCase());
      const hasMatch = normalizedTags.some(tag => normalizedFilterTags.includes(tag));
      if (hasMatch) return true;
    }
    
    return false;
  };

  const toggleFilter = (filterType: FilterType) => {
    setActiveFilters(prev => {
      const newSet = new Set(prev);
      if (newSet.has(filterType)) {
        newSet.delete(filterType);
      } else {
        newSet.add(filterType);
      }
      return newSet;
    });
  };

  // --- Render Helpers ---

  const monthYear = currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });
  const daysInMonth = getDaysInMonth(currentDate.getFullYear(), currentDate.getMonth());
  const firstDay = getFirstDayOfMonth(currentDate.getFullYear(), currentDate.getMonth());
  
  const daysArray = Array.from({ length: 42 }, (_, i) => {
    const day = i - firstDay + 1;
    return (day > 0 && day <= daysInMonth) ? day : null;
  });

  const getDayData = (day: number): DayData => {
    const date = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
    const dateStr = toLocalISOString(date); 
    const dayMarkets = markets.filter(m => m.resolveDate === dateStr);
    const dayPANews = panewsEvents[dateStr] || [];
    const analysis = analyses[dateStr];
    
    // Check if any market has been updated SINCE the analysis was generated
    let hasStaleAnalysis = false;
    let hasSignificantChange = false;

    if (analysis) {
        const latestMarketUpdate = Math.max(...dayMarkets.map(m => m.lastUpdated || 0));
        if (latestMarketUpdate > analysis.timestamp) {
            hasStaleAnalysis = true;
        }
    }

    // Check for big changes
    if (dayMarkets.some(m => m.changeDelta && Math.abs(m.changeDelta) > SIGNIFICANT_CHANGE_THRESHOLD)) {
        hasSignificantChange = true;
    }

    return {
      date: dateStr,
      markets: dayMarkets,
      manualEvents: manualEvents[dateStr] || [],
      panewsEvents: dayPANews,
      analysis,
      hasStaleAnalysis,
      hasSignificantChange
    };
  };

  const currentDayData = selectedDate ? (() => {
    try {
      const parsedDate = parseDate(selectedDate);
      const dayData = getDayData(parsedDate.getDate());
      // Ensure date matches selectedDate (in case of month boundaries)
      if (dayData.date === selectedDate) {
        return dayData;
      }
      // Fallback: construct directly
      return {
        date: selectedDate,
        markets: markets.filter(m => m.resolveDate === selectedDate),
        manualEvents: manualEvents[selectedDate] || [],
        panewsEvents: panewsEvents[selectedDate] || [],
        analysis: analyses[selectedDate],
        hasStaleAnalysis: false,
        hasSignificantChange: false
      };
    } catch (e) {
      console.error("Error parsing selected date:", e);
      return null;
    }
  })() : null;

  // Helper to check if a date is today
  const isTodayDate = (year: number, month: number, day: number): boolean => {
    const today = new Date();
    return (
      today.getFullYear() === year &&
      today.getMonth() === month &&
      today.getDate() === day
    );
  };

  // Close filters dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (showFilters && !target.closest('.filters-dropdown-container')) {
        setShowFilters(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showFilters]);

  // Format time ago helper
  const formatTimeAgo = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    
    if (seconds < 60) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  // Update time ago display every 10 seconds
  const [timeAgoDisplay, setTimeAgoDisplay] = useState<string>('');
  useEffect(() => {
    if (!lastMarketUpdate) {
      setTimeAgoDisplay('');
      return;
    }
    
    const updateDisplay = () => {
      setTimeAgoDisplay(formatTimeAgo(lastMarketUpdate));
    };
    
    updateDisplay(); // Initial update
    const interval = setInterval(updateDisplay, 10000); // Update every 10 seconds
    return () => clearInterval(interval);
  }, [lastMarketUpdate]);

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 font-sans">
      
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between sticky top-0 z-50 shadow-sm relative">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="bg-blue-600 text-white p-2 sm:p-2.5 rounded-lg shadow-blue-200 shadow-lg">
             <CalendarIcon size={20} className="sm:w-6 sm:h-6" />
          </div>
          <div>
            <h1 className="text-lg sm:text-xl font-bold text-slate-900 tracking-tight">Market Intelligence</h1>
            <div className="flex items-center gap-2">
              <p className="text-[10px] sm:text-xs text-slate-500 font-medium">Crypto Prediction Calendar</p>
              {timeAgoDisplay && (
                <span className="text-[11px] sm:text-xs text-slate-600 font-medium">
                  • Updated {timeAgoDisplay}
                </span>
              )}
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-2 sm:gap-4">
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5 sm:p-1 border border-slate-200 relative z-[60]" role="group" aria-label="Calendar navigation">
            <button 
              onClick={() => {
                const newDate = new Date(currentDate);
                newDate.setMonth(newDate.getMonth() - 1);
                setCurrentDate(newDate);
              }}
              aria-label="Previous month"
              className="p-1.5 sm:p-2 hover:bg-white rounded-md transition-colors text-slate-600 relative z-[60]"
            >
              <ChevronLeft size={16} className="sm:w-[18px] sm:h-[18px]" />
            </button>
            <span className="px-2 sm:px-4 font-semibold w-24 sm:w-32 text-center text-xs sm:text-sm" aria-live="polite">{monthYear}</span>
            <button 
              onClick={() => {
                const newDate = new Date(currentDate);
                newDate.setMonth(newDate.getMonth() + 1);
                setCurrentDate(newDate);
              }}
              aria-label="Next month"
              className="p-1.5 sm:p-2 hover:bg-white rounded-md transition-colors text-slate-600 relative z-[60]"
            >
              <ChevronRight size={16} className="sm:w-[18px] sm:h-[18px]" />
            </button>
          </div>
          <div className="relative filters-dropdown-container z-[60]">
            <button 
              onClick={() => setShowFilters(!showFilters)}
              aria-label={`${showFilters ? 'Close' : 'Open'} filters`}
              aria-expanded={showFilters}
              className={`p-1.5 sm:p-2 rounded-lg transition-colors flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm font-medium relative z-[60] ${
                activeFilters.size > 0
                  ? 'bg-blue-600 text-white hover:bg-blue-700' 
                  : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
              }`}
            >
              <Filter size={16} className="sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">Filters</span>
              {activeFilters.size > 0 && (
                <span className="bg-white/20 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                  {activeFilters.size}
                </span>
              )}
            </button>
            
            {/* Filters Dropdown */}
            {showFilters && (
              <div className="absolute right-0 top-full mt-2 bg-white rounded-lg shadow-xl border border-slate-200 z-[60] min-w-[180px]">
                <div className="p-3 border-b border-slate-100">
                  <h3 className="text-xs font-bold text-slate-700">Filter by Category</h3>
                </div>
                <div className="p-2 space-y-1">
                  {(['bitcoin', 'economy', 'politics'] as FilterType[]).map(filterType => (
                    <label
                      key={filterType}
                      className="flex items-center gap-2 p-2 hover:bg-slate-50 rounded cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={activeFilters.has(filterType)}
                        onChange={() => toggleFilter(filterType)}
                        className="w-4 h-4 text-blue-600 border-slate-300 rounded focus:ring-blue-500"
                      />
                      <span className="text-xs font-medium text-slate-700 capitalize">
                        {filterType === 'bitcoin' ? 'Bitcoin' : filterType}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button 
            onClick={toggleCrossAnalysisMode}
            aria-label={`${isCrossAnalysisMode ? 'Exit' : 'Enter'} cross analysis mode`}
            aria-pressed={isCrossAnalysisMode}
            className={`p-1.5 sm:p-2 rounded-lg transition-colors flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm font-medium relative z-[60] ${
              isCrossAnalysisMode 
                ? 'bg-blue-600 text-white hover:bg-blue-700' 
                : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
            }`}
          >
            <GitBranch size={16} className="sm:w-4 sm:h-4" />
            <span className="hidden sm:inline">Cross Analysis</span>
          </button>
          <button 
            onClick={async () => {
              if (!openAIKey) {
                alert("Please enter your OpenAI API Key in settings first.");
                return;
              }
              if (isClassifyingBTCImpact) return;
              
              setIsClassifyingBTCImpact(true);
              setBtcImpactProgress({ current: 0, total: 0 });
              
              try {
                const result = await classifyBTCImpact(db, appId, openAIKey, {
                  force: true, // Force regeneration to reclassify all events
                  onProgress: (current, total) => {
                    setBtcImpactProgress({ current, total });
                  }
                });
                
                alert(`BTC Impact classification complete!\n\nClassified: ${result.classified}\nSkipped: ${result.skipped}\nErrors: ${result.errors}${result.errorsList.length > 0 ? `\n\nErrors:\n${result.errorsList.slice(0, 5).join('\n')}${result.errorsList.length > 5 ? `\n... and ${result.errorsList.length - 5} more` : ''}` : ''}`);
              } catch (error) {
                console.error('BTC Impact classification failed:', error);
                alert('BTC Impact classification failed. Check console for details.');
              } finally {
                setIsClassifyingBTCImpact(false);
                setBtcImpactProgress({ current: 0, total: 0 });
              }
            }}
            disabled={isClassifyingBTCImpact}
            aria-label="Regenerate BTC Impact"
            className={`p-1.5 sm:p-2 rounded-lg transition-colors flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm font-medium relative z-[60] ${
              isClassifyingBTCImpact
                ? 'bg-blue-600 text-white cursor-wait'
                : 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
            }`}
          >
            {isClassifyingBTCImpact ? (
              <>
                <Loader2 size={16} className="sm:w-4 sm:h-4 animate-spin" />
                <span className="hidden sm:inline">
                  {btcImpactProgress.total > 0 ? `${btcImpactProgress.current}/${btcImpactProgress.total}` : 'Classifying...'}
                </span>
              </>
            ) : (
              <>
                <Activity size={16} className="sm:w-4 sm:h-4" />
                <span className="hidden sm:inline">Regenerate BTC Impact</span>
              </>
            )}
          </button>
          <button 
            onClick={() => setShowSettings(true)}
            aria-label="Open settings"
            className="p-1.5 sm:p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors relative z-[60]"
          >
            <Settings size={18} className="sm:w-5 sm:h-5" />
          </button>
        </div>
      </header>

      {/* Main Grid */}
      <main className="p-3 sm:p-4 md:p-6 w-full relative z-0">
        {loading ? (
            <div className="flex justify-center items-center h-96">
                <Loader2 className="animate-spin text-blue-500 w-10 h-10 sm:w-12 sm:h-12" />
            </div>
        ) : (
            <div className="grid grid-cols-7 gap-px bg-slate-200 border border-slate-200 rounded-lg overflow-hidden shadow-sm w-full">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                <div key={d} className="bg-slate-50 py-2 sm:py-3 text-center text-[10px] sm:text-xs font-bold text-slate-500 uppercase tracking-wider">
                {d}
                </div>
            ))}
            
            {daysArray.map((day, i) => {
              const dateStr = day ? toLocalISOString(new Date(currentDate.getFullYear(), currentDate.getMonth(), day)) : null;
              const isToday = day ? isTodayDate(currentDate.getFullYear(), currentDate.getMonth(), day) : false;
              const isValidDate = dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
              return (
                <DayCell 
                  key={i} 
                  day={day || 0} 
                  isCurrentMonth={!!day}
                  data={day ? getDayData(day) : undefined}
                  onClick={() => {
                    if (day && !isCrossAnalysisMode && isValidDate) {
                      setSelectedDate(dateStr);
                    }
                  }}
                  isCrossAnalysisMode={isCrossAnalysisMode}
                  isSelected={isValidDate && dateStr ? selectedDays.has(dateStr) : false}
                  onMouseDown={isValidDate && dateStr ? () => handleMouseDown(dateStr) : undefined}
                  onMouseEnter={isValidDate && dateStr ? () => handleMouseEnter(dateStr) : undefined}
                  onMouseUp={isValidDate && dateStr ? () => handleMouseUp(dateStr) : undefined}
                  eventMatchesFilters={eventMatchesFilters}
                  isToday={isToday}
                  hasActiveFilters={activeFilters.size > 0}
                />
              );
            })}
            </div>
        )}
      </main>

      {/* Detail Modal */}
      {selectedDate && currentDayData && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[100] flex items-center justify-center p-3 sm:p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto flex flex-col">
            
            {/* Modal Header */}
            <div className={`p-4 sm:p-6 border-b border-slate-100 flex justify-between items-start 
              ${currentDayData.analysis?.verdict === 'BULLISH' ? 'bg-emerald-50/50' : 
                currentDayData.analysis?.verdict === 'BEARISH' ? 'bg-rose-50/50' : 'bg-white'}`}>
              <div className="flex-1 min-w-0 pr-2">
                <h2 className="text-lg sm:text-xl md:text-2xl font-bold text-slate-800 flex flex-wrap items-center gap-2 sm:gap-3">
                  <span className="break-words">{parseDate(selectedDate).toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
                  {currentDayData.analysis && (
                     <span className={`text-[10px] sm:text-xs px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-full border font-bold uppercase tracking-wider whitespace-nowrap
                        ${currentDayData.analysis.verdict === 'BULLISH' ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 
                          currentDayData.analysis.verdict === 'BEARISH' ? 'bg-rose-100 text-rose-700 border-rose-200' : 
                          'bg-slate-100 text-slate-700 border-slate-200'}`}>
                        {currentDayData.analysis.verdict}
                     </span>
                  )}
                  {currentDayData.hasStaleAnalysis && (
                      <span className="flex items-center gap-1 text-[10px] sm:text-xs bg-orange-100 text-orange-700 px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-full border border-orange-200 font-bold whitespace-nowrap">
                          <AlertCircle size={10} className="sm:w-3 sm:h-3"/> Update Needed
                      </span>
                  )}
                </h2>
                <p className="text-slate-500 text-xs sm:text-sm mt-1">Daily Briefing & Intelligence</p>
              </div>
              <button 
                onClick={() => setSelectedDate(null)} 
                aria-label="Close modal"
                className="text-slate-400 hover:text-slate-700 flex-shrink-0"
              >
                <X size={20} className="sm:w-6 sm:h-6" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-4 sm:p-6 space-y-6 sm:space-y-8">
              
              {/* 1. Markets Section */}
              <section>
                <h3 className="text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-wider mb-2 sm:mb-3 flex items-center gap-1.5 sm:gap-2">
                  <Activity size={14} className="sm:w-4 sm:h-4"/> Market Resolutions
                </h3>
                {currentDayData.markets.length === 0 ? (
                    <p className="text-slate-400 text-sm italic">No markets expiring today.</p>
                ) : (
                    <div className="grid gap-2">
                    {/* Show ALL individual markets in detail modal (not filtered by catalyst) */}
                    {currentDayData.markets.map(m => {
                        const isBigChange = m.changeDelta && Math.abs(m.changeDelta) > SIGNIFICANT_CHANGE_THRESHOLD;
                        const changePercentNum = m.changeDelta ? m.changeDelta * 100 : 0;
                        const changePercent = changePercentNum.toFixed(0);
                        const matches = eventMatchesFilters(m.tags);
                        
                        // In detail modal, prefer question field if available (shows specific market question)
                        // Otherwise fall back to title (for markets without question field)
                        const displayText = m.question || m.title;
                        
                        // Apply BTC impact background color
                        const bgColorClass = m.btcImpact === 'bullish' 
                          ? 'bg-emerald-50 border-emerald-100' 
                          : m.btcImpact === 'bearish' 
                          ? 'bg-rose-50 border-rose-100' 
                          : 'bg-slate-50 border-slate-100';
                        
                        return (
                            <div 
                              key={m.id} 
                              className={`flex items-center justify-between p-2 sm:p-3 ${bgColorClass} rounded-lg group hover:border-blue-200 transition-colors gap-2 ${
                                !matches ? 'opacity-40 grayscale' : ''
                              }`}
                            >
                                <div className="flex flex-col min-w-0 flex-1">
                                    <span className="font-medium text-slate-700 text-sm sm:text-base">{displayText}</span>
                                    {isBigChange && (
                                        <span className="text-[9px] sm:text-[10px] text-amber-600 font-bold flex items-center gap-0.5 sm:gap-1 mt-1">
                                            <TrendingUp size={9} className="sm:w-2.5 sm:h-2.5"/> Moved {changePercentNum > 0 ? '+' : ''}{changePercent}% recently
                                        </span>
                                    )}
                                </div>
                                <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
                                    <span className="text-[10px] sm:text-xs text-slate-400 uppercase hidden sm:inline">{m.source}</span>
                                    <span className={`font-bold px-2 sm:px-2.5 py-1 rounded text-xs sm:text-sm whitespace-nowrap ${m.probability > 0.5 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                                        {(m.probability * 100).toFixed(0)}% Yes
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                    </div>
                )}
              </section>

              {/* 2. Manual Events Section */}
              <section>
                 <h3 className="text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-wider mb-2 sm:mb-3 flex items-center gap-1.5 sm:gap-2">
                  <CalendarIcon size={14} className="sm:w-4 sm:h-4"/> Events & Catalysts
                </h3>
                <div className="space-y-2 sm:space-y-3">
                    {currentDayData.manualEvents.map((e, idx) => {
                      const matches = eventMatchesFilters(undefined);
                      return (
                        <div 
                          key={idx} 
                          className={`flex items-start gap-2 p-2 sm:p-3 bg-amber-50/50 border border-amber-100 rounded-lg transition-all ${
                            !matches ? 'opacity-40 grayscale' : ''
                          }`}
                        >
                            <span className="text-amber-500 mt-0.5 text-sm sm:text-base">📢</span>
                            <span className="flex-1 text-slate-700 text-xs sm:text-sm">{e}</span>
                            <button onClick={() => removeManualEvent(selectedDate, idx)} className="text-slate-300 hover:text-rose-500 flex-shrink-0"><Trash2 size={12} className="sm:w-3.5 sm:h-3.5"/></button>
                        </div>
                      );
                    })}
                    
                    <form 
                        onSubmit={(e) => {
                            e.preventDefault();
                            const form = e.currentTarget;
                            const input = form.elements.namedItem('eventText') as HTMLInputElement;
                            if (input && input.value.trim()) {
                            addManualEvent(selectedDate, input.value);
                            input.value = '';
                            }
                        }}
                        className="flex gap-2"
                    >
                        <input 
                            name="eventText"
                            type="text" 
                            placeholder="Add a catalyst..." 
                            aria-label="Add manual event"
                            className="flex-1 border border-slate-200 rounded-lg px-2 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <button type="submit" className="bg-slate-900 text-white px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg hover:bg-slate-800 transition-colors flex-shrink-0">
                            <Plus size={16} className="sm:w-[18px] sm:h-[18px]" />
                        </button>
                    </form>
                </div>
              </section>

              {/* 2.5. PA News Events Section */}
              {currentDayData.panewsEvents.length > 0 && (
                <section>
                  <h3 className="text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-wider mb-2 sm:mb-3 flex items-center gap-1.5 sm:gap-2">
                    <Activity size={14} className="sm:w-4 sm:h-4"/> PA News Events
                  </h3>
                  <div className="space-y-2 sm:space-y-3">
                    {currentDayData.panewsEvents.map((e) => {
                      const matches = eventMatchesFilters(e.tags);
                      return (
                        <div 
                          key={e.id} 
                          className={`flex items-start gap-2 p-2 sm:p-3 bg-blue-50/50 border border-blue-100 rounded-lg transition-all group ${
                            !matches ? 'opacity-40 grayscale' : ''
                          }`}
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-slate-700 text-xs sm:text-sm font-medium">{e.title}</span>
                          </div>
                          <a
                            href={e.source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-500 hover:text-blue-700 flex-shrink-0 p-1 hover:bg-blue-100 rounded transition-colors"
                            aria-label={`Open ${e.title} in PA News`}
                            title="Open in PA News"
                          >
                            <ExternalLink size={14} className="sm:w-4 sm:h-4" />
                          </a>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* 3. AI Analysis Section */}
              <section className="relative">
                 <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-3 sm:mb-4 gap-2 sm:gap-0">
                    <h3 className="text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1.5 sm:gap-2">
                        <BrainCircuit size={14} className="sm:w-4 sm:h-4"/> AI Assessment
                    </h3>
                    
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
                        {currentDayData.hasStaleAnalysis && (
                            <span className="text-[10px] sm:text-xs text-orange-600 font-bold">
                                Data Updated since last run
                            </span>
                        )}
                        <button 
                            onClick={() => runAnalysis(selectedDate, currentDayData.markets, currentDayData.manualEvents, currentDayData.panewsEvents)}
                            disabled={isAnalysing || (!currentDayData.markets.length && !currentDayData.manualEvents.length && !currentDayData.panewsEvents.length)}
                            className={`text-xs flex items-center justify-center gap-1.5 sm:gap-2 px-3 py-1.5 sm:py-2 rounded-full font-medium transition-all
                                ${isAnalysing ? 'bg-slate-100 text-slate-400 cursor-wait' : 
                                  currentDayData.hasStaleAnalysis ? 'bg-orange-500 text-white hover:bg-orange-600 shadow-md shadow-orange-200 animate-pulse' :
                                  'bg-indigo-600 text-white hover:bg-indigo-700 shadow-md shadow-indigo-200'}`}
                        >
                            {isAnalysing ? <Loader2 className="animate-spin w-3 h-3 sm:w-3.5 sm:h-3.5"/> : <RefreshCw size={14} className="sm:w-3.5 sm:h-3.5"/>}
                            <span className="whitespace-nowrap">{currentDayData.hasStaleAnalysis ? 'Update Analysis' : 
                             currentDayData.analysis ? 'Re-Run Analysis' : 'Generate Analysis'}</span>
                        </button>
                    </div>
                 </div>

                 {currentDayData.analysis ? (
                    <div className={`bg-slate-50 border rounded-xl p-3 sm:p-4 md:p-5 space-y-3 sm:space-y-4 text-xs sm:text-sm leading-relaxed text-slate-700
                        ${currentDayData.hasStaleAnalysis ? 'border-orange-300 ring-1 ring-orange-100' : 'border-slate-200'}`}>
                        {/* We display raw text inside a styled container for flexibility, or we can use the parsed fields */}
                        <div className="prose prose-sm prose-slate max-w-none">
                             <div className="whitespace-pre-wrap font-medium font-mono text-[10px] sm:text-xs bg-white p-2 sm:p-3 md:p-4 rounded border border-slate-200 text-slate-600 overflow-x-auto">
                                {currentDayData.analysis.rawText}
                             </div>
                        </div>
                        <div className="flex justify-end text-[10px] sm:text-xs text-slate-400">
                            Generated: {new Date(currentDayData.analysis.timestamp).toLocaleString()}
                        </div>
                    </div>
                 ) : (
                    <div className="border-2 border-dashed border-slate-200 rounded-xl p-6 sm:p-8 text-center">
                        <p className="text-slate-400 text-xs sm:text-sm">
                            {(!currentDayData.markets.length && !currentDayData.manualEvents.length && !currentDayData.panewsEvents.length) 
                                ? "Add events or markets to enable analysis."
                                : "No analysis generated yet. Click the button above to analyze this day's events."}
                        </p>
                    </div>
                 )}
              </section>

            </div>
          </div>
        </div>
      )}

      {/* Cross Analysis Panel */}
      {isCrossAnalysisMode && (
        <>
          {isCrossAnalysisCollapsed ? (
            // Collapsed Tab View
            <div 
              onClick={() => setIsCrossAnalysisCollapsed(false)}
              className="fixed bottom-4 right-4 bg-gradient-to-r from-blue-50 to-indigo-50 rounded-t-xl shadow-2xl border border-slate-200 border-b-0 z-[55] px-4 py-2 cursor-pointer hover:from-blue-100 hover:to-indigo-100 transition-colors"
            >
              <div className="flex items-center gap-2">
                <GitBranch size={14} className="text-blue-600" />
                <span className="text-xs font-bold text-slate-800">Cross Analysis</span>
                <span className="text-xs text-slate-600">({selectedDays.size} selected)</span>
                <ChevronUp size={14} className="text-slate-600 ml-1" />
              </div>
            </div>
          ) : (
            // Expanded Panel View
            <div className="fixed bottom-4 right-4 bg-white rounded-xl shadow-2xl border border-slate-200 z-[55] max-w-md w-full sm:w-96 max-h-[80vh] overflow-y-auto flex flex-col">
              <div className="p-4 bg-gradient-to-r from-blue-50 to-indigo-50 border-b border-slate-200 flex justify-between items-center">
                <div>
                  <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                    <GitBranch size={16} className="text-blue-600" />
                    Cross Analysis
                  </h3>
                  <p className="text-xs text-slate-600 mt-1 font-medium">{selectedDays.size} day{selectedDays.size !== 1 ? 's' : ''} selected</p>
                </div>
                <div className="flex items-center gap-1">
                  <button 
                    onClick={() => setIsCrossAnalysisCollapsed(true)}
                    className="text-slate-400 hover:text-slate-700 hover:bg-white/50 rounded-lg p-1 transition-colors"
                    title="Collapse panel"
                  >
                    <ChevronDown size={18} />
                  </button>
                  <button 
                    onClick={toggleCrossAnalysisMode}
                    className="text-slate-400 hover:text-slate-700 hover:bg-white/50 rounded-lg p-1 transition-colors"
                    title="Close cross analysis"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>

          {/* Tab Switcher */}
          <div className="px-4 pt-4 pb-3 border-b border-slate-200 bg-white">
            <div className="flex bg-slate-100 rounded-lg p-0.5 shadow-inner">
              <button
                onClick={() => setCrossAnalysisTab('analysis')}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-md transition-all ${
                  crossAnalysisTab === 'analysis'
                    ? 'shadow-sm border border-blue-200'
                    : ''
                }`}
                style={crossAnalysisTab === 'analysis' ? { 
                  backgroundColor: '#ffffff',
                  color: '#1e40af',
                  borderColor: '#bfdbfe'
                } : {
                  backgroundColor: 'transparent',
                  color: '#475569'
                }}
                onMouseEnter={(e) => {
                  if (crossAnalysisTab !== 'analysis') {
                    e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.85)';
                    e.currentTarget.style.color = '#0f172a';
                  }
                }}
                onMouseLeave={(e) => {
                  if (crossAnalysisTab !== 'analysis') {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = '#475569';
                  }
                }}
              >
                Analysis
              </button>
              <button
                onClick={() => setCrossAnalysisTab('chat')}
                className={`flex-1 px-3 py-2 text-xs font-semibold rounded-md transition-all ${
                  crossAnalysisTab === 'chat'
                    ? 'shadow-sm border border-blue-200'
                    : ''
                }`}
                style={crossAnalysisTab === 'chat' ? { 
                  backgroundColor: '#ffffff',
                  color: '#1e40af',
                  borderColor: '#bfdbfe'
                } : {
                  backgroundColor: 'transparent',
                  color: '#475569'
                }}
                onMouseEnter={(e) => {
                  if (crossAnalysisTab !== 'chat') {
                    e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.85)';
                    e.currentTarget.style.color = '#0f172a';
                  }
                }}
                onMouseLeave={(e) => {
                  if (crossAnalysisTab !== 'chat') {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = '#475569';
                  }
                }}
              >
                Chat
              </button>
            </div>
          </div>
          
          <div className="p-4 space-y-4 bg-white">
            {/* Selected Days List */}
            <div className="max-h-32 overflow-y-auto">
              <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2.5">Selected Dates</p>
              {selectedDays.size > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {Array.from(selectedDays).sort().map(dateStr => (
                    <span 
                      key={dateStr}
                      className="text-xs bg-blue-50 text-blue-700 px-2.5 py-1 rounded-md border border-blue-200 font-medium shadow-sm"
                    >
                      {parseDate(dateStr).toLocaleDateString('default', { month: 'short', day: 'numeric' })}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-slate-400 italic bg-slate-50 px-3 py-2 rounded-lg border border-slate-100">No dates selected. Click on calendar cells to select dates.</p>
              )}
            </div>

            {/* Chat Input (only in Chat tab) */}
            {crossAnalysisTab === 'chat' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">Your Question</label>
                  <textarea
                    value={chatQuery}
                    onChange={(e) => setChatQuery(e.target.value)}
                    placeholder="What if CPI surprises higher?&#10;Which event dominates across these days?&#10;An ETF approval just happened — how does it affect later events?"
                    className="w-full h-24 border border-slate-300 rounded-lg px-3 py-2.5 text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-none bg-white text-slate-700 placeholder:text-slate-400"
                    rows={4}
                  />
                </div>
                
                {/* Screenshot/Image Upload (optional) */}
                <div>
                  <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
                    Screenshot/Image (Optional)
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        // Clean up previous preview URL
                        if (imagePreviewUrl) {
                          URL.revokeObjectURL(imagePreviewUrl);
                        }
                        if (file) {
                          setUploadedImage(file);
                          setImagePreviewUrl(URL.createObjectURL(file));
                        } else {
                          setUploadedImage(null);
                          setImagePreviewUrl(null);
                        }
                      }}
                      className="hidden"
                      id="image-upload-input"
                    />
                    <label
                      htmlFor="image-upload-input"
                      className="flex-1 cursor-pointer border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-600 hover:bg-slate-50 transition-colors"
                    >
                      {uploadedImage ? uploadedImage.name : "Choose image file..."}
                    </label>
                    {uploadedImage && (
                      <button
                        onClick={() => {
                          if (imagePreviewUrl) {
                            URL.revokeObjectURL(imagePreviewUrl);
                          }
                          setUploadedImage(null);
                          setImagePreviewUrl(null);
                        }}
                        className="text-slate-400 hover:text-slate-700 px-2 py-1 text-xs"
                        title="Remove image"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                  {imagePreviewUrl && (
                    <div className="mt-2">
                      <img
                        src={imagePreviewUrl}
                        alt="Preview"
                        className="max-w-full max-h-32 rounded border border-slate-200"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Action Buttons */}
            <div className="flex gap-2.5">
              <button
                onClick={runCrossAnalysis}
                disabled={
                  isRunningCrossAnalysis || 
                  selectedDays.size === 0 || 
                  (crossAnalysisTab === 'chat' && !chatQuery.trim())
                }
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-semibold text-sm transition-all ${
                  isRunningCrossAnalysis ||
                  selectedDays.size === 0 ||
                  (crossAnalysisTab === 'chat' && !chatQuery.trim())
                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                    : 'bg-blue-600 text-white hover:bg-blue-700 shadow-md shadow-blue-200 hover:shadow-lg'
                }`}
              >
                {isRunningCrossAnalysis ? (
                  <>
                    <Loader2 className="animate-spin w-4 h-4" />
                    <span>Analyzing...</span>
                  </>
                ) : (
                  <>
                    <BrainCircuit size={16} />
                    <span>Run Analysis</span>
                  </>
                )}
              </button>
              <button
                onClick={clearSelection}
                className="px-4 py-2.5 rounded-lg font-semibold text-sm transition-all border shadow-sm"
                style={{ 
                  backgroundColor: '#ffffff',
                  color: '#1e293b',
                  borderColor: '#cbd5e1'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = '#f8fafc';
                  e.currentTarget.style.color = '#0f172a';
                  e.currentTarget.style.borderColor = '#94a3b8';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = '#ffffff';
                  e.currentTarget.style.color = '#1e293b';
                  e.currentTarget.style.borderColor = '#cbd5e1';
                }}
                onMouseDown={(e) => {
                  e.currentTarget.style.backgroundColor = '#f1f5f9';
                }}
                onMouseUp={(e) => {
                  e.currentTarget.style.backgroundColor = '#f8fafc';
                }}
              >
                Clear
              </button>
            </div>

            {/* Results Display */}
            {crossAnalysisResult && (
              <div className="mt-4 pt-4 border-t border-slate-200">
                <div className="flex items-center gap-2 mb-3">
                  <BrainCircuit size={14} className="text-blue-600" />
                  <p className="text-xs font-semibold text-slate-700 uppercase tracking-wider">Analysis Result</p>
                </div>
                <div className="bg-gradient-to-br from-slate-50 to-blue-50/30 border border-slate-200 rounded-lg p-4 max-h-96 overflow-y-auto shadow-inner">
                  <div className="whitespace-pre-wrap text-xs text-slate-800 leading-relaxed font-sans">
                    {crossAnalysisResult}
                  </div>
                </div>
              </div>
            )}
          </div>
            </div>
          )}
        </>
      )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[100] flex items-center justify-center p-3 sm:p-4">
           <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-4 sm:p-6 space-y-4 sm:space-y-6">
              <div className="flex justify-between items-center gap-2">
                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4 min-w-0 flex-1">
                    <h2 className="text-base sm:text-lg font-bold text-slate-800">Settings</h2>
                    <div className="flex bg-slate-100 rounded-lg p-0.5 sm:p-1">
                        <button 
                            onClick={() => setActiveTab('import')}
                            className={`px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-bold rounded-md transition-colors ${activeTab === 'import' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}
                        >
                            Import
                        </button>
                        <button 
                            onClick={() => setActiveTab('debug')}
                            className={`px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-bold rounded-md transition-colors ${activeTab === 'debug' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}
                        >
                            Debug Data
                        </button>
                    </div>
                  </div>
                  <button onClick={() => setShowSettings(false)} className="text-slate-400 hover:text-slate-700 flex-shrink-0"><X size={18} className="sm:w-5 sm:h-5"/></button>
              </div>
              
              {/* === IMPORT TAB === */}
              {activeTab === 'import' && (
                  <>
                    {/* OpenAI Key */}
                    <div>
                        <label className="block text-[10px] sm:text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5 sm:mb-2">OpenAI API Key</label>
                        <input 
                            type="password" 
                            value={openAIKey}
                            onChange={(e) => setOpenAIKey(e.target.value)}
                            placeholder="sk-..."
                            aria-label="OpenAI API Key"
                            className="w-full border border-slate-200 rounded-lg px-2 sm:px-3 py-1.5 sm:py-2 text-xs sm:text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                        />
                        <p className="text-[9px] sm:text-[10px] text-slate-400 mt-1">Required for AI Analysis. Not stored permanently.</p>
                    </div>

                    {/* Data Sources Section */}
                    <div className="border-t border-slate-100 pt-3 sm:pt-4">
                        <label className="block text-[10px] sm:text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5 sm:mb-2 flex items-center gap-1.5 sm:gap-2">
                            <Database size={12} className="sm:w-3.5 sm:h-3.5"/> Data Sources
                        </label>
                        
                        {/* PA News Sync */}
                        <div className="mb-4 sm:mb-6">
                            <div className="flex items-center justify-between mb-2">
                                <div>
                                    <p className="text-[10px] sm:text-xs font-semibold text-slate-700">PA News Calendar</p>
                                    <p className="text-[9px] sm:text-[10px] text-slate-500">
                                        Sync events from PA News API (next 90 days)
                                    </p>
                                </div>
                            </div>
                            
                            {panewsImportStatus !== 'idle' && (
                                <div className={`mb-2 flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-xs font-semibold
                                ${panewsImportStatus === 'success' ? 'text-green-600' : 
                                    panewsImportStatus === 'error' ? 'text-red-600' : 'text-blue-600'}`}>
                                {panewsImportStatus === 'loading' && <Loader2 className="animate-spin w-3 h-3 sm:w-3.5 sm:h-3.5"/>}
                                {panewsImportStatus === 'success' && <CheckCircle2 size={12} className="sm:w-3.5 sm:h-3.5"/>}
                                {panewsImportStatus === 'error' && <AlertCircle size={12} className="sm:w-3.5 sm:h-3.5"/>}
                                <span>
                                    {panewsImportStatus === 'loading' ? 'Syncing from PA News API...' :
                                    panewsImportStatus === 'success' ? 'Sync Complete!' :
                                    panewsImportStatus === 'error' ? 'Sync Failed' : ''}
                                </span>
                                </div>
                            )}

                            <button 
                                onClick={syncPANewsEvents}
                                disabled={panewsImportStatus === 'loading'}
                                className={`w-full flex justify-center items-center gap-1.5 sm:gap-2 text-white text-[10px] sm:text-xs font-bold py-2 sm:py-2.5 rounded transition-colors
                                ${panewsImportStatus === 'loading' ? 'bg-slate-400 cursor-wait' : 'bg-blue-600 hover:bg-blue-700'}`}
                            >
                                {panewsImportStatus === 'loading' ? (
                                    <>
                                        <Loader2 className="animate-spin w-3 h-3 sm:w-3.5 sm:h-3.5"/>
                                        <span>Syncing...</span>
                                    </>
                                ) : (
                                    <>
                                        <RefreshCw size={12} className="sm:w-3.5 sm:h-3.5"/>
                                        <span>Sync PA News Events</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </div>

                    {/* Data Import */}
                    <div className="border-t border-slate-100 pt-3 sm:pt-4">
                        <label className="block text-[10px] sm:text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5 sm:mb-2 flex items-center gap-1.5 sm:gap-2">
                            <FileJson size={12} className="sm:w-3.5 sm:h-3.5"/> Import Data
                        </label>
                        <p className="text-[10px] sm:text-xs text-slate-600 mb-2">Paste JSON output from n8n below (Large payloads supported):</p>
                        <textarea 
                            value={jsonInput}
                            onChange={(e) => setJsonInput(e.target.value)}
                            className="w-full h-48 sm:h-64 border border-slate-200 rounded-lg px-2 sm:px-3 py-1.5 sm:py-2 text-[10px] sm:text-xs font-mono focus:ring-2 focus:ring-blue-500 outline-none resize-y"
                            placeholder='[{ "title": "...", "resolveDate": "2024-10-01", ... }]'
                        />
                        
                        {/* Status Indicator */}
                        {importStatus !== 'idle' && (
                            <div className={`mt-2 flex items-center gap-1.5 sm:gap-2 text-[10px] sm:text-xs font-semibold
                            ${importStatus === 'success' ? 'text-green-600' : 
                                importStatus === 'error' ? 'text-red-600' : 'text-blue-600'}`}>
                            {importStatus === 'loading' && <Loader2 className="animate-spin w-3 h-3 sm:w-3.5 sm:h-3.5"/>}
                            {importStatus === 'success' && <CheckCircle2 size={12} className="sm:w-3.5 sm:h-3.5"/>}
                            {importStatus === 'error' && <AlertCircle size={12} className="sm:w-3.5 sm:h-3.5"/>}
                            <span>
                                {importStatus === 'loading' ? 'Importing data...' :
                                importStatus === 'success' ? 'Import Complete!' :
                                importStatus === 'error' ? 'Import Failed. Check JSON format.' : ''}
                            </span>
                            </div>
                        )}

                        <div className="flex flex-col sm:flex-row gap-2 mt-2">
                            <button 
                                onClick={handleImportN8n}
                                disabled={importStatus === 'loading'}
                                className={`flex-1 flex justify-center items-center gap-1.5 sm:gap-2 text-white text-[10px] sm:text-xs font-bold py-2 sm:py-2.5 rounded transition-colors
                                ${importStatus === 'loading' ? 'bg-slate-400' : 'bg-slate-900 hover:bg-slate-800'}`}
                            >
                                {importStatus === 'loading' ? 'Processing...' : 'Import JSON'}
                            </button>
                            <button 
                                onClick={simulateN8nData}
                                disabled={importStatus === 'loading'}
                                className="flex-1 bg-white border border-slate-200 text-slate-700 text-[10px] sm:text-xs font-bold py-2 sm:py-2.5 rounded hover:bg-slate-50 transition-colors"
                            >
                                Load Mock Data
                            </button>
                        </div>

                        <div className="mt-4 sm:mt-6 pt-3 sm:pt-4 border-t border-slate-100">
                             <button 
                                onClick={clearAllData}
                                className="w-full text-center text-[10px] sm:text-xs text-red-400 hover:text-red-600 transition-colors"
                             >
                                Clear all data (Reset)
                             </button>
                        </div>
                    </div>
                  </>
              )}

              {/* === DEBUG TAB === */}
              {activeTab === 'debug' && (
                  <div className="space-y-3 sm:space-y-4">
                      <div className="bg-slate-50 p-3 sm:p-4 rounded-lg border border-slate-200">
                          <h3 className="font-bold text-xs sm:text-sm text-slate-700 mb-1.5 sm:mb-2 flex items-center gap-1.5 sm:gap-2"><Database size={12} className="sm:w-3.5 sm:h-3.5"/> Database Inspector</h3>
                          <p className="text-[10px] sm:text-xs text-slate-500 mb-3 sm:mb-4">
                              Below is a sample of the data currently loaded in the application. Use this to verify that your imported dates match what you expect.
                          </p>
                          <div className="bg-white border border-slate-200 rounded max-h-96 overflow-auto">
                              <table className="w-full text-[10px] sm:text-xs text-left">
                                  <thead className="bg-slate-100 sticky top-0">
                                      <tr>
                                          <th className="p-1.5 sm:p-2 border-b">ID</th>
                                          <th className="p-1.5 sm:p-2 border-b">Title</th>
                                          <th className="p-1.5 sm:p-2 border-b">Resolve Date (DB)</th>
                                          <th className="p-1.5 sm:p-2 border-b">Prob</th>
                                      </tr>
                                  </thead>
                                  <tbody>
                                      {markets.length === 0 ? (
                                          <tr><td colSpan={4} className="p-3 sm:p-4 text-center text-slate-400 text-xs">No data found.</td></tr>
                                      ) : (
                                          markets.slice(0, 50).map(m => (
                                              <tr key={m.id} className="border-b hover:bg-slate-50">
                                                  <td className="p-1.5 sm:p-2 font-mono text-slate-400 truncate max-w-[60px] sm:max-w-[80px]" title={m.id}>{m.id}</td>
                                                  <td className="p-1.5 sm:p-2 truncate max-w-[100px] sm:max-w-[150px]" title={m.title}>{m.title}</td>
                                                  <td className="p-1.5 sm:p-2 font-mono text-blue-600 font-bold">{m.resolveDate}</td>
                                                  <td className="p-1.5 sm:p-2">{(m.probability*100).toFixed(0)}%</td>
                                              </tr>
                                          ))
                                      )}
                                  </tbody>
                              </table>
                          </div>
                      </div>
                  </div>
              )}
           </div>
        </div>
      )}

    </div>
  );
}