/**
 * Backend server with API endpoint and cron scheduler
 * 
 * For deployment: This can run on Vercel, Railway, Render, or any Node.js host
 * For local with proxy: Set HTTP_PROXY and HTTPS_PROXY environment variables
 */

import express, { type Request, type Response } from 'express';
import cron from 'node-cron';
import { updateMarkets } from './marketUpdater.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());

/**
 * Manual endpoint to trigger market update
 * POST /api/update-markets
 */
app.post('/api/update-markets', async (_req: Request, res: Response) => {
  try {
    console.log('Manual market update triggered');
    const result = await updateMarkets();
    
    res.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in manual update:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Cron job: Run market update every minute
 * Format: second minute hour day month weekday
 * 
 * NOTE: On serverless platforms (Vercel), cron jobs may not work.
 * Use Vercel Cron Jobs or external cron service instead.
 */
if (process.env.ENABLE_CRON !== 'false') {
  cron.schedule('* * * * *', async () => {
    console.log(`[Cron] Running scheduled market update at ${new Date().toISOString()}`);
    try {
      await updateMarkets();
    } catch (error) {
      console.error('[Cron] Error in scheduled update:', error);
    }
  });
  console.log('Cron scheduler enabled');
} else {
  console.log('Cron scheduler disabled (ENABLE_CRON=false)');
}

// Start server (only if not on Vercel/serverless)
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`Market updater server running on port ${PORT}`);
    console.log(`Manual endpoint: POST http://localhost:${PORT}/api/update-markets`);
    if (process.env.ENABLE_CRON !== 'false') {
      console.log(`Cron schedule: Every minute`);
    }
  });
}

// Export for Vercel/serverless
export default app;
