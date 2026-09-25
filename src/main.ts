/**
 * BidWisely Procurement Matcher – main entry point (multi-provider AI)
 *
 * Flow:
 *   1. Read input (startUrls, smeProfile, maxItems, keywords, enableAiExtraction,
 *      aiProvider + up to three provider keys)
 *   2. Run CheerioCrawler across Nigerian procurement portals
 *   3. On LISTING pages -> enqueue individual tender links (label: DETAIL)
 *   4. On DETAIL pages  -> extract via whichever AI provider is configured
 *      (falls back across providers, then to heuristics), match against the
 *      SME profile, pushData
 *   5. After crawl -> run AI Agent summary and persist to Key-Value Store
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { CheerioCrawler } from '@crawlee/cheerio';
import { Actor, log } from 'apify';

import { runAiAgentSummary } from './agent.js';
import { router } from './routes.js';
import type { Input, SmeProfile } from './types.js';

// ─── Graceful abort ──────────────────────────────────────────────────────────
await Actor.init();

Actor.on('aborting', async () => {
    log.warning('Actor is aborting - persisting state and exiting...');
    await sleep(1000);
    await Actor.exit();
});

// ─── Input ───────────────────────────────────────────────────────────────────
const input = await Actor.getInput<Input>();

if (!input) {
    throw new Error('Actor input is missing. Please provide startUrls and smeProfile.');
}

const {
    startUrls = [{ url: 'https://www.tender.ng/' }],
    maxItems = 18,
    keywords = [],
    enableAiExtraction = true,
    aiProvider = 'openai',
    aiApiKey: inputAiApiKey,
    aiModel,
    smeProfile = {},
    maxRequestsPerCrawl = 200,
    proxyConfiguration,
} = input;

const envKeyMap: Record<string, string | undefined> = {
    openai: process.env.OPENAI_API_KEY ?? process.env.OpenAI_API_KEY,
    gemini: process.env.GEMINI_API_KEY ?? process.env.Gemini_API_KEY,
    claude: process.env.CLAUDE_API_KEY ?? process.env.Claude_API_KEY,
};

const resolvedAiApiKey = inputAiApiKey ?? envKeyMap[aiProvider];

// True only when the USER typed a key into the input. In that case
// they are paying that provider directly, so we must not also charge ai-extraction.
const userSuppliedKey = Boolean(inputAiApiKey);

const anyKeyConfigured = Boolean(resolvedAiApiKey || envKeyMap.openai || envKeyMap.gemini || envKeyMap.claude);

if (enableAiExtraction && !anyKeyConfigured) {
    log.warning('No AI API keys found. AI extraction is disabled; falling back to heuristic extraction for this run.');
} else if (enableAiExtraction && !resolvedAiApiKey) {
    log.warning(`No API key found for preferred provider ${aiProvider.toUpperCase()}. Will attempt to fall back to other configured providers in your environment.`);
}

if (resolvedAiApiKey) {
    process.env[`${aiProvider.toUpperCase()}_API_KEY`] = resolvedAiApiKey;
}
if (aiModel) {
    process.env[`${aiProvider.toUpperCase()}_MODEL`] = aiModel;
}
process.env.AI_PROVIDER = aiProvider;
process.env.USER_SUPPLIED_KEY = userSuppliedKey ? '1' : '0';

// Share configuration via env so the router (separate module) can read it
process.env.SME_PROFILE = JSON.stringify(smeProfile);
process.env.MAX_ITEMS = String(maxItems);
process.env.MAX_ITEMS_PER_SOURCE = String(Math.ceil(maxItems / Math.max(1, startUrls.length)));
process.env.KEYWORDS = JSON.stringify(keywords);
process.env.ENABLE_AI_EXTRACTION = String(enableAiExtraction);

log.info('BidWisely Procurement Matcher starting', {
    maxItems,
    keywords,
    enableAiExtraction,
    aiProvider,
    providersConfigured: {
        openai: Boolean(envKeyMap.openai),
        gemini: Boolean(envKeyMap.gemini),
        claude: Boolean(envKeyMap.claude),
    },
    startUrls: startUrls.map((u) => u.url),
});

// ─── Proxy Configuration ─────────────────────────────────────────────────────
const proxy = await Actor.createProxyConfiguration(proxyConfiguration);

// ─── Crawler ─────────────────────────────────────────────────────────────────
const crawler = new CheerioCrawler({
    proxyConfiguration: proxy,
    maxRequestsPerCrawl,
    // Respect rate limits - Nigerian gov portals are slow
    minConcurrency: 1,
    maxConcurrency: 5,
    requestHandlerTimeoutSecs: 90,
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
log.info('Running AI Agent to summarise matched opportunities...');
await runAiAgentSummary({ smeProfile: smeProfile as SmeProfile, chargeForInsight: !userSuppliedKey });

log.info('BidWisely run complete.');
await Actor.exit();