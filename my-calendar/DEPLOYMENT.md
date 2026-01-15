# Backend Deployment Guide

## Problem
If you're in China, the Great Firewall blocks Google services (including Firestore) from Node.js. Your frontend works because browsers can use proxies/VPNs, but Node.js backend needs different configuration.

## Solution Options

### Option 1: Deploy to Vercel (Recommended - Free Tier Available)

**Steps:**
1. Install Vercel CLI: `npm i -g vercel`
2. Login: `vercel login`
3. Deploy: `vercel --prod`
4. Set environment variables in Vercel dashboard:
   - Copy `firebase-service-account.json` content
   - Add as `FIREBASE_SERVICE_ACCOUNT` environment variable (JSON string)
5. Configure Vercel Cron Jobs (for scheduled updates):
   - Go to Vercel dashboard → Your project → Settings → Cron Jobs
   - Add: `* * * * *` (every minute) → `/api/update-markets`

**Pros:**
- Free tier available
- Automatic HTTPS
- Global CDN
- Easy deployment

**Cons:**
- Serverless functions have execution time limits
- Need to configure cron jobs separately

---

### Option 2: Deploy to Railway (Recommended for Cron Jobs)

**Steps:**
1. Go to [railway.app](https://railway.app)
2. New Project → Deploy from GitHub
3. Connect your GitHub repo
4. Railway will auto-detect Node.js
5. Set environment variables:
   - Add `firebase-service-account.json` content as `FIREBASE_SERVICE_ACCOUNT`
6. Railway will automatically run `npm run backend`

**Pros:**
- Supports long-running processes (cron jobs work)
- Free tier with $5 credit
- Easy deployment
- Automatic HTTPS

**Cons:**
- Free tier has limits

---

### Option 3: Deploy to Render

**Steps:**
1. Go to [render.com](https://render.com)
2. New → Web Service
3. Connect GitHub repo
4. Build command: `npm install`
5. Start command: `npm run backend`
6. Add environment variables (same as Railway)

**Pros:**
- Free tier available
- Supports cron jobs
- Easy setup

---

### Option 4: Use Proxy for Local Development

If you want to keep running locally with a VPN/proxy:

**Set environment variables:**
```bash
export HTTP_PROXY=http://your-proxy:port
export HTTPS_PROXY=http://your-proxy:port
npm run backend:dev
```

Or create `.env` file:
```
HTTP_PROXY=http://your-proxy:port
HTTPS_PROXY=http://your-proxy:port
```

**Note:** Node.js `fetch` and Firebase Admin SDK should automatically use these proxy settings.

---

## Recommended: Railway or Render

For cron jobs that run every minute, Railway or Render are better than Vercel because:
- They support long-running processes
- Cron jobs work natively
- No execution time limits

## Quick Start with Railway

1. Push your code to GitHub
2. Go to railway.app → New Project
3. Deploy from GitHub
4. Add environment variable: `FIREBASE_SERVICE_ACCOUNT` = (paste JSON content)
5. Deploy!

The backend will automatically start and run cron jobs.
