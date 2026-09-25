/**
 * BidWisely - Matching Engine (unchanged scoring logic, bug fixes only)
 *  - No more crash when profile.capacity is missing
 *  - Certification check now lists exactly which certs are missing
 *  - Location gets the same "benefit of the doubt" treatment as capacity
 */

import { normalizeCert } from './extractor.js';
import type { MatchResult, Opportunity, SmeProfile } from './types.js';

const WEIGHTS = { industry: 35, location: 25, capacity: 20, certifications: 10, keywords: 10 };

function scoreLabel(score: number): string {
    if (score >= 85) return 'Excellent Match';
    if (score >= 65) return 'Good Match';
    if (score >= 40) return 'Partial Match';
    return 'Poor Match';
}

export function matchOpportunity(opportunity: Opportunity, profile: SmeProfile, filterKeywords: string[] = []): MatchResult {
    const industryMatch =
        !!profile.industry && !!opportunity.category &&
        opportunity.category.toLowerCase().includes(profile.industry.toLowerCase());

    // Unknown location on either side: benefit of the doubt, same as capacity
    const locationMatch =
        !profile.location || !opportunity.location ||
        opportunity.location.toLowerCase().includes(profile.location.toLowerCase());

    const capacityMatch =
        opportunity.contractValueMax == null || profile.capacity == null ||
        profile.capacity >= opportunity.contractValueMax;

    const owned = new Set((profile.certifications ?? []).map(normalizeCert));
    const missingCerts = opportunity.certifications.filter((c) => !owned.has(c));
    const certificationMatch = missingCerts.length === 0;

    const opportunityText = [opportunity.title, opportunity.category, opportunity.buyer, ...(opportunity.requirements ?? [])]
        .filter(Boolean).join(' ').toLowerCase();
    const smeKeywords = [...(profile.services ?? []), ...(filterKeywords ?? [])].map((k) => k.toLowerCase());
    const keywordsMatch = smeKeywords.length === 0 || smeKeywords.some((kw) => opportunityText.includes(kw));

    const checks = { industry: industryMatch, location: locationMatch, capacity: capacityMatch, certifications: certificationMatch, keywords: keywordsMatch };
    const score =
        (checks.industry ? WEIGHTS.industry : 0) +
        (checks.location ? WEIGHTS.location : 0) +
        (checks.capacity ? WEIGHTS.capacity : 0) +
        (checks.certifications ? WEIGHTS.certifications : 0) +
        (checks.keywords ? WEIGHTS.keywords : 0);

    const missingRequirements: string[] = [];
    if (!checks.industry) missingRequirements.push(`Industry mismatch (you: ${profile.industry || 'unknown'}, tender: ${opportunity.category ?? 'unknown'})`);
    if (!checks.location) missingRequirements.push(`Location mismatch (you: ${profile.location ?? 'unknown'}, tender: ${opportunity.location ?? 'unknown'})`);
    if (!checks.capacity && opportunity.contractValueMax) {
        missingRequirements.push(`Contract value ${opportunity.contractValueMax.toLocaleString()} exceeds your capacity of ${(profile.capacity ?? 0).toLocaleString()}`);
    }
    if (!checks.certifications) missingRequirements.push(`Missing certifications: ${missingCerts.join(', ')}`);

    const passed = Object.values(checks).filter(Boolean).length;
    const explanation = [
        `Match score: ${score}%.`,
        `Passed ${passed}/${Object.keys(checks).length} criteria.`,
        missingRequirements.length ? `Action required: ${missingRequirements.join('; ')}.` : 'No immediate gaps detected.',
    ].join(' ');

    return {
        score,
        label: scoreLabel(score),
        basis: Object.entries(WEIGHTS).map(([k, w]) => `${k} (${w}%)`).join(', '),
        checks,
        missingRequirements,
        explanation,
    };
}