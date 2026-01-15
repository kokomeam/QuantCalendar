import { getFirestore, doc, setDoc, collection, getDocs } from 'firebase/firestore';

// MarketData type (matches App.tsx)
type MarketData = {
  id: string;
  title: string;
  resolveDate: string;
  probability: number;
  previousProbability?: number;
  changeDelta?: number;
  lastUpdated: number;
  source: 'n8n' | 'manual';
  catalyst?: string;
  question?: string;
  volume?: string | number;
  tags?: string[];
  btcImpact?: 'bullish' | 'bearish' | 'neutral';
  btcImpactUpdatedAt?: string;
  [key: string]: unknown;
};

type BitcoinPriceData = {
  priceUsd: number;
  change24hPct: number;
  source: "CoinGecko";
  fetchedAt: string;
};

type BTCImpactResult = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

/**
 * Fetches live Bitcoin price from CoinGecko API
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
    console.warn('Failed to fetch Bitcoin price:', error);
    return null;
  }
};

/**
 * Classifies a single event's BTC impact using OpenAI
 */
const classifyEventBTCImpact = async (
  event: MarketData,
  btcPrice: BitcoinPriceData | null,
  apiKey: string
): Promise<BTCImpactResult> => {
  try {
    const systemPrompt = `You are a crypto market analyst.

Your task is to classify whether a single event is:
- bullish for Bitcoin
- bearish for Bitcoin
- neutral / unrelated to Bitcoin

You must consider:
- Direct impact on Bitcoin demand, supply, regulation, liquidity, or sentiment
- Macro events that historically affect Bitcoin (rates, CPI, ETFs, regulation)
- Ignore altcoin-only events unless they clearly affect Bitcoin
- Market probability: The "Yes" percentage represents the prediction market's probability that the event will occur. Higher probabilities (e.g., 80%+) indicate the market expects the event to happen, while lower probabilities (e.g., 20%-) indicate the market expects it won't. Consider how the market's expectation of the event affects Bitcoin, not just the event itself.

You must output exactly ONE word:
BULLISH
BEARISH
NEUTRAL

No explanations.
No punctuation.
No extra text.`;

    const currentPriceContext = btcPrice 
      ? `Current Bitcoin Price: $${btcPrice.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${btcPrice.change24hPct >= 0 ? '+' : ''}${btcPrice.change24hPct.toFixed(2)}% 24h)\n\n`
      : '';

    const probabilityPercent = (event.probability * 100).toFixed(0);
    const probabilityContext = `Market Probability: ${probabilityPercent}% Yes (prediction market indicates ${probabilityPercent}% chance this event occurs)`;

    const userPrompt = `${currentPriceContext}${probabilityContext}\n\nEvent: ${event.title}${event.question ? `\nQuestion: ${event.question}` : ''}${event.catalyst ? `\nCatalyst: ${event.catalyst}` : ''}

Classify this event's impact on Bitcoin, considering both the event itself and the market's expectation (probability) of it occurring.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4-turbo",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.3, // Lower temperature for more consistent classification
        max_tokens: 10 // Only need one word
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
    }

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    
    const content = data.choices?.[0]?.message?.content?.trim().toUpperCase();
    
    if (content === 'BULLISH' || content === 'BEARISH' || content === 'NEUTRAL') {
      return content as BTCImpactResult;
    }
    
    // Default to neutral if response is unexpected
    console.warn(`Unexpected classification response: "${content}", defaulting to NEUTRAL`);
    return 'NEUTRAL';
  } catch (error) {
    console.error('Failed to classify event BTC impact:', error);
    // Return neutral on error to not block processing
    return 'NEUTRAL';
  }
};

export type ClassifyBTCImpactOptions = {
  force?: boolean; // If true, reclassify even if already classified
  onProgress?: (current: number, total: number) => void;
};

export type ClassifyBTCImpactResult = {
  classified: number;
  skipped: number;
  errors: number;
  errorsList: string[];
};

/**
 * Main service function to classify BTC impact for all events
 */
export const classifyBTCImpact = async (
  db: ReturnType<typeof getFirestore>,
  appId: string,
  apiKey: string,
  options: ClassifyBTCImpactOptions = {}
): Promise<ClassifyBTCImpactResult> => {
  const result: ClassifyBTCImpactResult = {
    classified: 0,
    skipped: 0,
    errors: 0,
    errorsList: []
  };

  try {
    // Fetch current BTC price once
    const btcPrice = await fetchLiveBitcoinPrice();
    if (btcPrice) {
      console.log('Fetched BTC price:', btcPrice.priceUsd);
    }

    // Get all markets from Firestore
    const marketsRef = collection(db, 'artifacts', appId, 'public', 'data', 'markets');
    const marketsSnapshot = await getDocs(marketsRef);
    
    const allMarkets: MarketData[] = [];
    marketsSnapshot.forEach(doc => {
      allMarkets.push(doc.data() as MarketData);
    });

    console.log(`Found ${allMarkets.length} events to classify`);

    // Process each event
    for (let i = 0; i < allMarkets.length; i++) {
      const market = allMarkets[i];
      
      // Skip if already classified and not forcing
      if (!options.force && market.btcImpact && market.btcImpactUpdatedAt) {
        result.skipped++;
        if (options.onProgress) {
          options.onProgress(i + 1, allMarkets.length);
        }
        continue;
      }

      try {
        // Classify the event
        const impact = await classifyEventBTCImpact(market, btcPrice, apiKey);
        
        // Update the market document in Firestore
        const marketRef = doc(db, 'artifacts', appId, 'public', 'data', 'markets', market.id);
        await setDoc(marketRef, {
          ...market,
          btcImpact: impact.toLowerCase() as 'bullish' | 'bearish' | 'neutral',
          btcImpactUpdatedAt: new Date().toISOString()
        }, { merge: true });

        result.classified++;
        
        if (options.onProgress) {
          options.onProgress(i + 1, allMarkets.length);
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        result.errors++;
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        result.errorsList.push(`Event ${market.id}: ${errorMsg}`);
        console.error(`Error classifying event ${market.id}:`, error);
      }
    }

    console.log('BTC Impact classification complete:', result);
    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    result.errorsList.push(`Fatal error: ${errorMsg}`);
    console.error('Fatal error in classifyBTCImpact:', error);
    return result;
  }
};
