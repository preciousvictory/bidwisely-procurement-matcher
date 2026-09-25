/**
 * BidWisely - Cheerio Router (patched)
 *
 * Fixes vs. the original:
 *  - Extract and validate BEFORE charging anything (junk pages cost nothing)
 *  - Charge ai-extraction only when the AI call actually succeeded
 *  - Skip ai-extraction charge entirely when the user supplied their own OpenAI key
 *  - Stop the crawl once maxItems is reached or the spending limit is hit
 *  - Give the reserved slot back on a skip or a thrown error, so retries and
 *    junk pages never eat into maxItems
 */

import { createCheerioRouter } from '@crawlee/cheerio';
import { Actor, log } from 'apify';

import { extractOpportunity, isLikelyTender } from './extractor.js';
import { matchOpportunity } from './matcher.js';
import type { CheerioHints, MatchedOpportunity, MatchStatus } from './types.js';

export const router = createCheerioRouter();

let processedCount = 0;
// Fair per-source budgeting: prevents one fast-responding source from
// consuming the whole maxItems budget before slower sources get a turn.
const domainCounts = new Map<string, number>();

function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return 'unknown';
    }
}

function parseUrlSlug(url: string): CheerioHints {
    const empty: CheerioHints = { title: null, buyer: null, location: null, deadline: null, requirements: [] };
    try {
        const { pathname } = new URL(url);
        const slug = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
        if (!pathname.includes('/view/') && !/_\d+$/.test(slug)) return empty;

        const withoutId = slug.replace(/_\d+$/, '');
        const pipeIdx = withoutId.indexOf('|');
        const buyer =
            pipeIdx >= 0
                ? withoutId
                      .slice(pipeIdx + 1)
                      .replace(/-+/g, ' ')
                      .replace(/\s+/g, ' ')
                      .trim()
                : null;
        const beforePipe = pipeIdx >= 0 ? withoutId.slice(0, pipeIdx).replace(/-$/, '') : withoutId;

        const tripleMatch = beforePipe.match(/^(.+?)---(.+)$/);
        const dashMatch = !tripleMatch ? beforePipe.match(/^(.+?)[–—](.+)$/) : null;

        if (tripleMatch) {
            return {
                title: tripleMatch[1].replace(/-+/g, ' ').trim(),
                location: tripleMatch[2].replace(/-+/g, ' ').trim(),
                buyer,
                deadline: null,
                requirements: [],
            };
        }
        if (dashMatch) {
            return {
                title: dashMatch[1].replace(/-+/g, ' ').trim(),
                location: dashMatch[2].replace(/-+/g, ' ').trim(),
                buyer,
                deadline: null,
                requirements: [],
            };
        }
        return {
            title: beforePipe.replace(/-+/g, ' ').trim() || null,
            location: null,
            buyer,
            deadline: null,
            requirements: [],
        };
    } catch {
        return empty;
    }
}

function isDetailUrl(url: string): boolean {
    const p = url.toLowerCase();

    // 1. Explicit detail page indicators
    if (
        p.includes('/view/') ||
        p.includes('detail') ||
        p.includes('/notice/') ||
        p.includes('tender') ||
        p.includes('procure') ||
        p.includes('contract') ||
        p.includes('project') ||
        p.includes('bid') ||
        p.includes('id=') || // catches ?tender_id=123 or &tndrId=xyz
        /\/\d+$/.test(p) // catches /tenders/12345
    ) {
        return true;
    }

    // 2. Common start phrases for long WordPress-style procurement slugs
    if (
        p.includes('invitation-to') ||
        p.includes('request-for') ||
        p.includes('expression-of') ||
        p.includes('pre-qualification') ||
        p.includes('technical-bidding') ||
        p.includes('supply-of')
    ) {
        return true;
    }

    // 3. Catch-all for "just / and long text"
    // If the URL has a lot of hyphens, it's almost certainly a blog post/detail page
    // and not a generic listing page like /tenders.
    try {
        const urlObj = new URL(url);
        // Get the last meaningful part of the URL path
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        const slug = pathParts[pathParts.length - 1] || '';

        // If the slug contains 3 or more hyphens, treat it as a detail page
        // e.g., /kebbi-state-ministry-of-works-invitation-to-tender
        if ((slug.match(/-/g) || []).length >= 3) {
            return true;
        }
    } catch (e) {
        // Fallback if URL parsing fails
        log.warning(`Failed to parse URL for detail check: ${url}. Error: ${(e as Error).message}`);
    }

    return false;
}

router.addHandler('LISTING', async ({ $, request, enqueueLinks }) => {
    log.info(`[LISTING] Scanning: ${request.loadedUrl}`);

    const selectorGroups = [
        { selector: 'a[href*="/view/"]', label: 'DETAIL' },
        { selector: 'a[href*="/tender-detail"]', label: 'DETAIL' },
        { selector: 'a[href*="/notice/"]', label: 'DETAIL' },
        { selector: 'a.tender-link', label: 'DETAIL' },
        { selector: 'a.opportunity', label: 'DETAIL' },
        { selector: '.tender-title a', label: 'DETAIL' },
        { selector: 'h2 a[href*="tender"]', label: 'DETAIL' },
        { selector: 'h3 a[href*="tender"]', label: 'DETAIL' },
        { selector: 'table tr td a[href*="tender"]', label: 'DETAIL' },
    ];

    for (const { selector, label } of selectorGroups) {
        const found = $(selector).length;
        if (found > 0) {
            log.info(`[LISTING] Enqueuing ${found} links with selector "${selector}"`);
            await enqueueLinks({
                selector,
                label,
                transformRequestFunction: (req) => (isDetailUrl(req.url) ? req : false),
            });
            return;
        }
    }

    const broadCount = $(
        'a[href*="tender"], a[href*="bid"], a[href*="procure"], a[href*="contract"], a[href*="project"]',
    ).length;
    if (broadCount > 0) {
        log.info(`[LISTING] Broad fallback: enqueuing filtered set from ${broadCount} tender-related links`);
        await enqueueLinks({
            selector: 'a[href*="tender"], a[href*="bid"], a[href*="procure"], a[href*="contract"], a[href*="project"]',
            label: 'DETAIL',
            transformRequestFunction: (req) => (isDetailUrl(req.url) ? req : false),
        });
        return;
    }

    log.info('[LISTING] No explicit tender links found, enqueuing all links for deeper discovery');
    await enqueueLinks({ label: 'LISTING' });
});

router.addHandler('DETAIL', async ({ $, request, crawler }) => {
    const maxItems = parseInt(process.env.MAX_ITEMS || '10', 10);
    const enableAiExtraction = process.env.ENABLE_AI_EXTRACTION !== 'false';
    const userSuppliedKey = process.env.USER_SUPPLIED_KEY === '1';
    const keywords: string[] = JSON.parse(process.env.KEYWORDS || '[]');
    const smeProfile = JSON.parse(process.env.SME_PROFILE || '{}');

    // maxItemsPerSource defaults to an even split across your startUrls if not set explicitly
    const maxItemsPerSource = parseInt(process.env.MAX_ITEMS_PER_SOURCE || String(maxItems), 10);
    const hostname = hostnameOf(request.loadedUrl);

    if (processedCount >= maxItems) {
        await crawler.autoscaledPool?.abort();
        return;
    }

    const domainCount = domainCounts.get(hostname) ?? 0;
    if (domainCount >= maxItemsPerSource) {
        // This source already had its fair share this run. Skip it WITHOUT aborting,
        // so requests from other, slower-responding sources keep being processed.
        log.info(`[DETAIL] Skipping ${hostname}, already reached its per-source share (${maxItemsPerSource})`);
        return;
    }

    domainCounts.set(hostname, domainCount + 1);
    processedCount++;
    const mySlot = processedCount;
    let slotUsed = false;

    try {
        log.info(`[DETAIL] Reading [${mySlot}/${maxItems}]: ${request.loadedUrl}`);

        const urlHints = parseUrlSlug(request.loadedUrl);
        const h1Text = $('h1').first().text().trim();
        const h2Text = $('h2').first().text().trim();

        const cheerioHints: CheerioHints = {
            title:
                (h1Text && h1Text.length < 200 ? h1Text : null) ||
                (h2Text && h2Text.length < 200 ? h2Text : null) ||
                urlHints.title,
            buyer:
                $(
                    '.buyer, .entity, .organization, [class*="buyer"], [class*="org"], [class*="ministry"], [class*="agency"], .client-name',
                )
                    .first()
                    .text()
                    .trim() || urlHints.buyer,
            location:
                $('[class*="location"], [class*="state"], [class*="region"], [class*="address"], [class*="venue"]')
                    .first()
                    .text()
                    .trim() || urlHints.location,
            deadline:
                $(
                    '[class*="deadline"], [class*="closing"], [class*="submission"], [class*="due-date"], [class*="expiry"]',
                )
                    .first()
                    .text()
                    .trim() || null,
            requirements: $('ul li, ol li')
                .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
                .get()
                .filter((t) => t.length > 8 && t.length < 300)
                .slice(0, 20),
        };

        // ── Clean up DOM before extracting text so words aren't squished and boilerplate is removed ──
        $('script, style, noscript, nav, header, footer, iframe, svg, img, aside').remove();
        // Be careful not to remove <form> entirely, as some ASP.NET sites wrap the whole page in a form.
        $(
            '[class*="header"], [id*="header"], [class*="footer"], [id*="footer"], [class*="sidebar"], [id*="sidebar"], [class*="menu"], [id*="menu"], [class*="modal"], [id*="modal"], [class*="popup"], [style*="display: none"], [style*="display:none"]',
        ).remove();

        $('p, div, br, li, td, th, h1, h2, h3, h4, h5, h6').append(' ');

        const mainText = $('main, article, .content, #content, .tender-detail, .opportunity-detail').first().text();
        const rawText = (mainText.trim() || $('body').text()).replace(/\s+/g, ' ').trim().slice(0, 15000);

        // ── 1. Extract FIRST, before spending any money ──
        const { opportunity, aiUsed, aiProvider } = await extractOpportunity(
            rawText,
            request.loadedUrl,
            enableAiExtraction,
            cheerioHints,
        );

        // ── 2. Reject junk pages before charging anything ──
        if (!isLikelyTender(rawText, opportunity.title)) {
            log.info(`[DETAIL] Skipping non-tender page [${mySlot}/${maxItems}]: ${request.loadedUrl}`);
            processedCount--; // give the slot back, this run does not count against maxItems
            domainCounts.set(hostname, (domainCounts.get(hostname) ?? 1) - 1);
            return;
        }

        // ── 3. Mark slot as used since it's a valid tender ──
        slotUsed = true;

        // ── 4. Only charge for AI if it actually ran, and never when the user brought their own key ──
        let limitReached = false;
        if (aiUsed) {
            log.info(`[DETAIL] AI extraction via ${aiProvider}`);
            if (!userSuppliedKey) {
                const aiCharge = await Actor.charge({ eventName: 'ai-extraction' });
                limitReached = aiCharge.eventChargeLimitReached;
            }
        }

        // ── 5. Match against SME profile ──
        const match = matchOpportunity(opportunity, smeProfile, keywords);

        let matchStatus: MatchStatus = 'unmatched';
        if (match.score >= 65) matchStatus = 'matched';
        else if (match.score >= 40) matchStatus = 'partial';

        const record: MatchedOpportunity = {
            ...opportunity,
            matchScore: match.score,
            matchLabel: match.label,
            matchStatus,
            matchBasis: match.basis,
            matchChecks: match.checks,
            matchExplanation: match.explanation,
            missingRequirements: match.missingRequirements,
        };

        log.info(`[DETAIL] ${match.score}% (${match.label}) [${matchStatus}] - "${opportunity.title ?? 'Untitled'}"`);
        await Actor.pushData(record); // This inherently triggers 'apify-default-dataset-item' charge

        if (limitReached) {
            log.warning('[DETAIL] Spending limit reached after AI extraction, stopping crawl.');
            await crawler.autoscaledPool?.abort();
            return;
        }
        if (processedCount >= maxItems) {
            await crawler.autoscaledPool?.abort();
        }
    } catch (err) {
        if (!slotUsed) {
            processedCount--; // failed before anything was charged, so give the slot back
            domainCounts.set(hostname, (domainCounts.get(hostname) ?? 1) - 1);
        }
        log.warning(`[DETAIL] Failed on ${request.loadedUrl}: ${(err as Error).message}`);
        throw err; // real network/parse failures still go through maxRequestRetries
    }
});

router.addDefaultHandler(async ({ request, enqueueLinks }) => {
    log.info(`[DEFAULT] Unknown page type, scanning: ${request.loadedUrl}`);
    await enqueueLinks({ label: 'LISTING' });
});
