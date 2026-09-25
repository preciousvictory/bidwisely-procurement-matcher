import { describe, expect, it } from 'vitest';
import { matchOpportunity } from '../src/matcher.js';
import type { Opportunity, SmeProfile } from '../src/types.js';

describe('BidWisely Matcher', () => {
    it('should calculate match score correctly', () => {
        const opportunity: Opportunity = {
            title: 'Construction of Solar Powered Borehole',
            buyer: 'Ministry of Water Resources',
            category: 'Construction',
            location: 'Lagos',
            deadline: '2024-12-31',
            contractValue: null,
            contractValueMax: null,
            currency: null,
            requirements: ['Must have CAC', 'Must have Tax Clearance'],
            certifications: ['CAC registration', 'Tax clearance'],
            minExperienceYears: null,
            sourceUrl: 'https://example.com/tender',
            scrapedAt: new Date().toISOString()
        };

        const profile: SmeProfile = {
            industry: 'Construction',
            location: 'Lagos',
            capacity: 50000000,
            certifications: ['CAC', 'Tax Clearance'],
            services: ['Borehole Drilling', 'Construction'],
            experience: []
        };

        const result = matchOpportunity(opportunity, profile, ['solar', 'borehole']);

        // Industry match (35%) + Location match (25%) + Certs (10%) + Keywords (10%) = 80%
        // Since we have all certs, and capacity is fine.
        expect(result.score).toBeGreaterThan(60);
        expect(result.label).toBeDefined();
        expect(result.missingRequirements).toHaveLength(0);
    });

    it('should detect missing requirements', () => {
        const opportunity: Opportunity = {
            title: 'Supply of Medical Equipment',
            buyer: 'Ministry of Health',
            category: 'Medical',
            location: 'Abuja',
            deadline: null,
            contractValue: null,
            contractValueMax: null,
            currency: null,
            requirements: ['ISO 9001 Certification', 'PENCOM Certificate'],
            certifications: ['ISO 9001', 'PenCom compliance'],
            minExperienceYears: null,
            sourceUrl: 'https://example.com',
            scrapedAt: new Date().toISOString()
        };

        const profile: SmeProfile = {
            industry: 'Construction',
            location: 'Lagos',
            capacity: 5000000,
            certifications: ['CAC'],
            services: ['Building'],
            experience: []
        };

        const result = matchOpportunity(opportunity, profile, []);

        // Poor match, missing certs
        expect(result.score).toBeLessThan(40);
        expect(result.missingRequirements.length).toBeGreaterThan(0);
    });
});
