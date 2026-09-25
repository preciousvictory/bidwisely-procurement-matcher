/**
 * BidWisely - AI Agent Module (revised, multi-provider)
 *
 * Reads the dataset, drops expired tenders, ranks the rest, asks the model
 * (OpenAI, Gemini or Claude, with automatic fallback across whichever are
 * configured) for a briefing plus a "why / next step" per top tender,
 * validates that reply against the real records, and saves everything to
 * the Key-Value Store as AGENT_SUMMARY. If every provider is unavailable
 * the Actor still produces a deterministic, rule-based briefing.
 */

import { Actor, log } from 'apify';

import type { AiProvider } from './llmProvider.js';
import { callJsonWithFallback, collectKeys, extractJsonObject, hasAnyAiKey } from './llmProvider.js';
import type { MatchedOpportunity, SmeProfile } from './types.js';

interface AgentInput {
    smeProfile: SmeProfile;
    /** Set false when the user supplied their own provider key and should not pay twice. */
    chargeForInsight?: boolean;
}

interface Priority {
    sourceUrl: string;
    title: string | null;
    why: string;
    nextStep: string;
}

const MS_PER_DAY = 86_400_000;

function daysLeft(o: MatchedOpportunity): number | null {
    if (!o.deadline) return null;
    const t = Date.parse(o.deadline);
    return Number.isNaN(t) ? null : Math.ceil((t - Date.now()) / MS_PER_DAY);
}

const brief = (o: MatchedOpportunity) => ({
    title: o.title,
    buyer: o.buyer,
    category: o.category,
    location: o.location,
    deadline: o.deadline,
    daysLeft: daysLeft(o),
    contractValue: o.contractValue,
    matchScore: o.matchScore,
    matchLabel: o.matchLabel,
    missingRequirements: o.missingRequirements,
    matchExplanation: o.matchExplanation,
    sourceUrl: o.sourceUrl,
});

function fallbackBriefing(top: MatchedOpportunity[], urgent: number, total: number): string {
    if (top.length === 0) return `No strong matches were found among ${total} opportunities in this run.`;
    const best = top[0];
    return (
        `Best fit: "${best.title ?? 'Untitled'}" at ${best.matchScore}% relevance` +
        `${best.deadline ? `, closing ${best.deadline}` : ''}. ` +
        `${urgent > 0 ? `${urgent} tender(s) close within 7 days. ` : ''}` +
        'Open each original notice and confirm the requirements before bidding.'
    );
}

export async function runAiAgentSummary({ smeProfile, chargeForInsight = true }: AgentInput): Promise<void> {
    const dataset = await Actor.openDataset();
    const { items } = await dataset.getData({ limit: 1000 });
    const all = items as MatchedOpportunity[];

    if (all.length === 0) {
        log.warning('[agent] No opportunities found, skipping AI Agent summary.');
        await Actor.setValue('AGENT_SUMMARY', {
            generatedAt: new Date().toISOString(),
            totalOpportunities: 0,
            briefing: 'No procurement opportunities were found in this run.',
        });
        return;
    }

    // Never recommend closed tenders
    const open = all.filter((o) => (daysLeft(o) ?? 0) >= 0 || daysLeft(o) === null);
    const expiredCount = all.length - open.length;
    const byScore = [...open].sort((a, b) => b.matchScore - a.matchScore);

    const matched = byScore.filter((o) => o.matchStatus === 'matched');
    const partial = byScore.filter((o) => o.matchStatus === 'partial');
    const unmatched = byScore.filter((o) => o.matchStatus === 'unmatched');
    const top5 = [...matched, ...partial].slice(0, 5);
    const urgent = open.filter((o) => {
        const d = daysLeft(o);
        return d !== null && d >= 0 && d <= 7;
    });

    let briefing = fallbackBriefing(top5, urgent.length, open.length);
    let priorities: Priority[] = top5.map((o) => ({
        sourceUrl: o.sourceUrl,
        title: o.title,
        why: o.matchExplanation,
        nextStep: o.missingRequirements.length ? `Resolve: ${o.missingRequirements[0]}` : 'Read the original notice and prepare your documents.',
    }));
    let agentUsedAi = false;
    let agentProvider: AiProvider | null = null;

    const enableAiExtraction = process.env.ENABLE_AI_EXTRACTION !== 'false';
    const keys = collectKeys();
    if (enableAiExtraction && hasAnyAiKey(keys) && top5.length > 0) {
        const system = 'You are a procurement advisor for African SMEs. Return only JSON.';
        const user =
            `SME profile:\n${JSON.stringify({
                industry: smeProfile.industry,
                location: smeProfile.location ?? null,
                maxCapacityNgn: smeProfile.capacity ?? null,
                certifications: smeProfile.certifications ?? [],
                services: smeProfile.services ?? [],
            })}\n\n` +
            `Candidate tenders (already ranked by a rule-based relevance score):\n${JSON.stringify(top5.map(brief), null, 1)}\n\n` +
            'Use ONLY the data above. Do not invent tenders, values, dates or requirements.\n' +
            'You MUST reply with a raw JSON object and absolutely nothing else. Do not use markdown formatting. Structure:\n' +
            '{\n' +
            '  "briefing": "A highly detailed, 300-word executive summary. Explicitly detail WHY the top matches fit the SME profile (e.g., matching capacity, location, certifications) and note any missing requirements.",\n' +
            '  "priorities": [\n' +
            '    {\n' +
            '      "sourceUrl": "EXACT url from the data",\n' +
            '      "why": "Brief 40-word explanation of why this matches the profile",\n' +
            '      "nextStep": "Actionable next step to secure the bid"\n' +
            '    }\n' +
            '  ]\n' +
            '}';

        try {
            const preferred = (process.env.AI_PROVIDER as AiProvider | 'auto' | undefined) ?? 'auto';
            const { text, provider } = await callJsonWithFallback(keys, preferred, system, user, 1500);
            const parsed = extractJsonObject<{
                briefing?: unknown;
                priorities?: { sourceUrl?: unknown; why?: unknown; nextStep?: unknown }[];
            }>(text);

            if (!parsed || typeof parsed.briefing !== 'string') {
                log.warning('[agent] AI returned invalid JSON or missing briefing string. Raw output:', { text: text.slice(0, 500) });
            }

            const p = parsed ?? {};

            if (typeof p.briefing === 'string' && p.briefing.trim()) briefing = p.briefing.trim();

            // Keep only priorities that point at a real top5 record (guards against hallucinated URLs)
            const valid = new Map(top5.map((o) => [o.sourceUrl, o]));
            const cleaned: Priority[] = (p.priorities ?? [])
                .filter((priorityItem: { sourceUrl?: unknown; why?: unknown; nextStep?: unknown }) => typeof priorityItem.sourceUrl === 'string' && valid.has(priorityItem.sourceUrl) && typeof priorityItem.why === 'string' && typeof priorityItem.nextStep === 'string')
                .map((priorityItem: { sourceUrl?: unknown; why?: unknown; nextStep?: unknown }) => ({
                    sourceUrl: priorityItem.sourceUrl as string,
                    title: valid.get(priorityItem.sourceUrl as string)?.title ?? null,
                    why: priorityItem.why as string,
                    nextStep: priorityItem.nextStep as string,
                }));
            if (cleaned.length > 0) priorities = cleaned;
            agentUsedAi = true;
            agentProvider = provider;
        } catch (err) {
            log.warning('[agent] All AI providers failed, using rule-based briefing', { error: (err as Error).message });
        }
    }

    // Charge only when a model really produced the insight
    if (agentUsedAi && chargeForInsight) {
        const charge = await Actor.charge({ eventName: 'agent-insight' });
        if (charge.eventChargeLimitReached) log.warning('[agent] Spending limit reached after agent-insight.');
    }

    const summary = {
        generatedAt: new Date().toISOString(),
        smeProfile,
        totalOpportunities: all.length,
        expiredExcluded: expiredCount,
        aiGenerated: agentUsedAi,
        aiProvider: agentProvider,
        matched: matched.map(brief), // score >= 65
        partial: partial.map(brief), // score 40 to 64
        unmatched: unmatched.map(brief), // score < 40
        topMatches: top5.map(brief),
        priorities,
        urgentDeadlines: urgent.map((o) => ({ title: o.title, deadline: o.deadline, daysLeft: daysLeft(o), sourceUrl: o.sourceUrl })),
        briefing,
        note: 'Match scores show relevance to the SME profile, not the probability of winning.',
    };

    await Actor.setValue('AGENT_SUMMARY', summary);
    
    // Dump all opportunities clearly separating AI vs Heuristic extraction and AI conclusions
    const fullDump = all.map((o) => ({
        opportunityDetails: {
            title: o.title,
            buyer: o.buyer,
            category: o.category,
            location: o.location,
            deadline: o.deadline,
            contractValue: o.contractValue,
            requirements: o.requirements,
            certifications: o.certifications,
            minExperienceYears: o.minExperienceYears,
            sourceUrl: o.sourceUrl,
            scrapedAt: o.scrapedAt,
            extractedBy: o.extractionSource, // Shows whether 'gemini', 'openai', 'claude' or 'heuristic' pulled the data
        },
        matchingConclusion: {
            matchScore: o.matchScore,
            matchStatus: o.matchStatus, // matched, partial, unmatched
            matchLabel: o.matchLabel,
            missingRequirements: o.missingRequirements,
            explanation: o.matchExplanation, // Why it matched/failed
        }
    }));
    await Actor.setValue('ALL_OPPORTUNITIES', fullDump);

    await Actor.setStatusMessage(`Done. ${matched.length} strong, ${partial.length} partial matches. ${briefing.slice(0, 120)}`);
    log.info('[agent] AI Agent summary saved to Key-Value Store under "AGENT_SUMMARY"');
    log.info('[agent] Full list of ALL scraped opportunities saved to Key-Value Store under "ALL_OPPORTUNITIES"');
}