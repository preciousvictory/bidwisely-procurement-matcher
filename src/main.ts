/**
 * BidWisely Procurement Matcher – main entry point
 *
 * Flow:
 *   1. Read input (startUrls, smeProfile, maxItems, keywords, enableAiExtraction)
 *   2. Run CheerioCrawler across Nigerian procurement portals
 *   3. On LISTING pages → enqueue individual tender links (label: DETAIL)
 *   4. On DETAIL pages  → charge opportunity-discovered, extract via OpenAI,
 *      charge ai-extraction, match against SME profile, pushData
 *   5. After crawl → run AI Agent summary and persist to Key-Value Store
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { CheerioCrawler } from '@crawlee/cheerio';
import { Actor, log } from 'apify';

import { runAiAgentSummary } from './agent.js';
import { router } from './routes.js';
import type { Input, SmeProfile } from './types.js';

// ─── Graceful abort ──────────────────────────────────────────────────────────
Actor.on('aborting', async () => {
    log.warning('Actor is aborting – persisting state and exiting...');
    await sleep(1000);
    await Actor.exit();
});

await Actor.init();

// ─── Input ───────────────────────────────────────────────────────────────────
const input = await Actor.getInput<Input>();

if (!input) {
    throw new Error('❌  Actor input is missing. Please provide startUrls, smeProfile, and openAiApiKey.');
}

const {
    startUrls = [{ url: 'https://www.globaltenders.com/nigeria-tenders' }],
    maxItems = 18,
    keywords = [],
    enableAiExtraction = true,
    openAiApiKey: inputApiKey,
    smeProfile = {},
    maxRequestsPerCrawl = 200,
    proxyConfiguration,
} = input;

// Accept key from input OR from .env (Apify SDK loads .env automatically locally)
// .env may use either OPENAI_API_KEY or OpenAI_API_KEY (case varies)
const openAiApiKey =
    inputApiKey ??
    process.env.OPENAI_API_KEY ??
    process.env.OpenAI_API_KEY;

if (!openAiApiKey) {
    throw new Error(
        '❌  OpenAI API key not found.\n' +
        '  • Running on Apify Cloud? Add your key to the "OpenAI API Key" field in the Actor input form.\n' +
        '  • Running locally? Add OPENAI_API_KEY=sk-... to your .env file.\n' +
        '  • Want to run WITHOUT AI? Set enableAiExtraction to false in the input — no API key needed.',
    );
}

// Share configuration via env so the router (separate module) can read it
process.env.OPENAI_API_KEY = openAiApiKey;
process.env.SME_PROFILE = JSON.stringify(smeProfile);
process.env.MAX_ITEMS = String(maxItems);
process.env.MAX_ITEMS_PER_SOURCE = String(Math.ceil(maxItems / Math.max(1, startUrls.length)));
process.env.KEYWORDS = JSON.stringify(keywords);
process.env.ENABLE_AI_EXTRACTION = String(enableAiExtraction);

log.info('🚀  BidWisely Procurement Matcher starting', {
    maxItems,
    keywords,
    enableAiExtraction,
    startUrls: startUrls.map((u) => u.url),
});

// ─── Proxy Configuration ─────────────────────────────────────────────────────
const proxy = await Actor.createProxyConfiguration(proxyConfiguration);

// ─── Crawler ─────────────────────────────────────────────────────────────────
const crawler = new CheerioCrawler({
    proxyConfiguration: proxy,
    maxRequestsPerCrawl,
    // Respect rate limits – Nigerian gov portals are slow
    minConcurrency: 1,
    maxConcurrency: 5,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 30,
    requestHandler: router,
    // Retry failed requests up to 3 times
    maxRequestRetries: 3,
    // Allow failed requests to not crash the whole crawl
    failedRequestHandler: async ({ request }, error) => {
        log.warning(`Request failed after retries: ${request.url}`, { error: (error as Error).message });
    },
});

const startRequests = startUrls.map((req) => ({
    url: req.url,
    label: 'LISTING',
}));

await crawler.run(startRequests);

// ─── AI Agent Summary ────────────────────────────────────────────────────────
log.info('🤖  Running AI Agent to summarise matched opportunities...');
await runAiAgentSummary({ openAiApiKey, smeProfile: smeProfile as SmeProfile });

log.info('✅  BidWisely run complete.');
await Actor.exit();