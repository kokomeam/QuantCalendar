# Backend Market Updater

## Overview

Automatically updates probabilities for existing Polymarket markets stored in Firestore using the Gamma Markets API.

## Architecture

- **Location**: `/src/backend/`
- **Scheduling**: node-cron (runs every minute)
- **API**: Express server with manual trigger endpoint
- **Storage**: Firestore (updates existing markets only)

## Files

- `types.ts` - TypeScript type definitions
- `normalize.ts` - Data normalization (matches n8n logic exactly)
- `shockDetector.ts` - Market shock detection and alerting
- `marketUpdater.ts` - Main update logic
- `server.ts` - Express server with cron scheduler

## Assumptions & Notes

### Gamma API Structure

**ASSUMPTION**: The Gamma API endpoint structure is not fully documented in the provided link. The implementation assumes:

1. **Endpoint**: `https://gamma-api.polymarket.com/markets` (may need adjustment)
2. **Response Format**: Could be:
   - Direct array of events: `[{...}, {...}]`
   - Wrapped object: `{events: [...], markets: [...]}`
3. **Market ID Matching**: Markets are matched by question/title (case-insensitive)

**VERIFICATION**: The code logs the raw API response on first call. Check console output to verify actual structure.

### Market Matching

- Markets are matched by `Question` field (case-insensitive)
- Only markets that already exist in Firestore are updated
- No new markets are inserted

### Filtering Rules (Applied)

1. Volume ≥ $20,000 USD
2. Market NOT closed or resolved
3. Yes price strictly between 0.01 and 0.99
4. Keep up to 5 markets per event (sorted by volume)

### Shock Detection

- Threshold: ≥5% absolute probability change
- Alert trigger: ≥5 shocks in 15-minute rolling window
- Alerts stored in: `artifacts/{appId}/public/data/marketShockAlerts/{alertId}`

## Running

### Development
```bash
npm run backend:dev
```

### Production
```bash
npm run backend
```

### Manual Trigger
```bash
curl -X POST http://localhost:3001/api/update-markets
```

## Environment

- Port: 3001 (default) or set `PORT` env variable
- Firestore: Uses same config as frontend (hardcoded in `marketUpdater.ts`)

## Next Steps

1. **Verify Gamma API endpoint**: Check console logs for raw response structure
2. **Adjust endpoint if needed**: Update `fetchGammaMarkets()` in `marketUpdater.ts`
3. **Test market matching**: Ensure questions match between Gamma API and Firestore
4. **Monitor shock alerts**: Check Firestore for `marketShockAlerts` collection

## Dependencies

- `express` - HTTP server
- `node-cron` - Scheduled tasks
- `firebase` - Firestore access (already in project)
