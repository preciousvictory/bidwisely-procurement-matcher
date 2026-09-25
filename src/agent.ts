/**
 * BidWisely - AI Agent Module (revised)
 *
 * Reads the dataset, drops expired tenders, ranks the rest, asks the model for a
 * briefing plus a "why / next step" per top tender, validates that reply against the
 * real records, and saves everything to the Key-Value Store as AGENT_SUMMARY.
 * If the model is unavailable the Actor still produces a deterministic briefing.
 */

import { Actor, log } from 'apify';
import OpenAI from 'openai';

import type { MatchedOpportunity, SmeProfile } from './types.js';

interface AgentInput {
    openAiApiKey?: string;
    smeProfile: SmeProfile;
    /** Set false when the user supplied their own OpenAI key and should not pay twice. */
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
    sourceUrl: o.sourceUrl,
});

function fallbackBriefing(top: MatchedOpportunity[], urgent: number, total: number): string {
    if (top.length === 0) return `No strong matches were found among ${total} opportunities in this run.`;
    const best = top[0];
    return (
        `Best fit: "${best.title ?? 'Untitled'}" at ${best.matchScore}% relevance` +
        `${best.deadline ? `, closing ${best.deadline}` : ''}. ` +
        `${urgent > 0 ? `${urgent} tender(s) close within 7 days. ` : ''}` +
        `Open each original notice and confirm the requirements before bidding. Scores show relevance, not the chance of winning.`
    );
}

export async function runAiAgentSummary({ openAiApiKey, smeProfile, chargeForInsight = true }: AgentInput): Promise<void> {
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

    const apiKey = openAiApiKey ?? process.env.OPENAI_API_KEY;
    if (apiKey && top5.length > 0) {
        const prompt =
            `SME profile:\n${JSON.stringify({
                industry: smeProfile.industry,
                location: smeProfile.location ?? null,
                maxCapacityNgn: smeProfile.capacity ?? null,
                certifications: smeProfile.certifications ?? [],
                services: smeProfile.services ?? [],
            })}\n\n` +
            `Candidate tenders (already ranked by a rule-based relevance score; the score is NOT a chance of winning):\n${JSON.stringify(top5.map(brief), null, 1)}\n\n` +
            `Use ONLY the data above. Do not invent tenders, values, dates or requirements.\n` +
            `Return ONLY JSON: {"briefing": string (max 200 words, professional and encouraging), ` +
            `"priorities": [{"sourceUrl": string (copied exactly from the data), "why": string (max 25 words), "nextStep": string (max 20 words)}]}`;

        try {
            const client = new OpenAI({ apiKey, timeout: 40_000, maxRetries: 1 });
            const res = await client.chat.completions.create({
                model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
                temperature: 0.3,
                max_tokens: 900,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: 'You are a procurement advisor for African SMEs. Return only JSON.' },
                    { role: 'user', content: prompt },
                ],
            });
            const parsed = JSON.parse(res.choices[0]?.message?.content ?? '{}') as {
                briefing?: unknown;
                priorities?: { sourceUrl?: unknown; why?: unknown; nextStep?: unknown }[];
            };

            if (typeof parsed.briefing === 'string' && parsed.briefing.trim()) briefing = parsed.briefing.trim();

            // Keep only priorities that point at a real top5 record (guards against hallucinated URLs)
            const valid = new Map(top5.map((o) => [o.sourceUrl, o]));
            const cleaned: Priority[] = (parsed.priorities ?? [])
                .filter((p) => typeof p.sourceUrl === 'string' && valid.has(p.sourceUrl) && typeof p.why === 'string' && typeof p.nextStep === 'string')
                .map((p) => ({
                    sourceUrl: p.sourceUrl as string,
                    title: valid.get(p.sourceUrl as string)?.title ?? null,
                    why: p.why as string,
                    nextStep: p.nextStep as string,
                }));
            if (cleaned.length > 0) priorities = cleaned;
            agentUsedAi = true;
        } catch (err) {
            log.warning('[agent] OpenAI agent call failed, using rule-based briefing', { error: (err as Error).message });
        }
    }

    // Charge only when the model really produced the insight
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
    await Actor.setStatusMessage(`Done. ${matched.length} strong, ${partial.length} partial matches. ${briefing.slice(0, 120)}`);
    log.info('[agent] AI Agent summary saved to Key-Value Store under "AGENT_SUMMARY"');
}