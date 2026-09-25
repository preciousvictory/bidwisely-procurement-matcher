/**
 * Shared TypeScript types for BidWisely Procurement Matcher
 */

export interface Input {
    startUrls: { url: string }[];
    maxItems: number;
    maxRequestsPerCrawl: number;
    /** Which provider to use. */
    aiProvider?: 'openai' | 'gemini' | 'claude';
    aiApiKey?: string;
    aiModel?: string;
    smeProfile: SmeProfile;
    keywords: string[];
    enableAiExtraction: boolean;
    proxyConfiguration?: Record<string, unknown>;
}

export interface SmeProfile {
    industry: string;
    location?: string;
    capacity?: number;
    certifications?: string[];
    experience?: string[];
    services?: string[];
}

/** Fields extracted by Cheerio/URL before AI runs, treated as low-confidence hints */
export interface CheerioHints {
    title: string | null;
    buyer: string | null;
    location: string | null;
    deadline: string | null;
    requirements: string[];
}

export interface Opportunity {
    title: string | null;
    buyer: string | null;
    category: string | null;
    location: string | null;
    deadline: string | null; // ISO date YYYY-MM-DD
    contractValue: string | null; // display string, e.g. "₦45,000,000"
    contractValueMax: number | null;
    currency: string | null;
    requirements: string[];
    certifications: string[];
    minExperienceYears: number | null;
    sourceUrl: string;
    scrapedAt: string;
    extractionSource: string;
}

export interface MatchResult {
    score: number;
    label: string;
    basis: string;
    checks: {
        industry: boolean;
        location: boolean;
        capacity: boolean;
        certifications: boolean;
        keywords: boolean;
    };
    missingRequirements: string[];
    explanation: string;
}

export type MatchStatus = 'matched' | 'partial' | 'unmatched';

export interface MatchedOpportunity extends Opportunity {
    matchScore: number;
    matchLabel: string;
    matchStatus: MatchStatus;
    matchBasis: string;
    matchChecks: MatchResult['checks'];
    matchExplanation: string;
    missingRequirements: string[];
}