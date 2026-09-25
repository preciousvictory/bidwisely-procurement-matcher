/**
 * BidWisely - Multi-provider LLM client
 *
 * Tries OpenAI, Gemini and Claude in order (or a single preferred provider
 * first, then the others as fallback) so a bad/out-of-credit key on one
 * provider doesn't take AI extraction down for the whole run.
 * All three are called as plain JSON-in / JSON-out: give it a system prompt
 * and a user prompt, get back raw text that should contain one JSON object.
 */

import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';

export type AiProvider = 'openai' | 'gemini' | 'claude';

export interface ProviderKeys {
    openai?: string;
    gemini?: string;
    claude?: string;
}

export interface ProviderResult {
    text: string;
    provider: AiProvider;
}

const MODELS: Record<AiProvider, string> = {
    openai: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    gemini: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    claude: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
};

async function callOpenAI(apiKey: string, system: string, user: string, maxTokens: number): Promise<string> {
    const client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 0 });
    const res = await client.chat.completions.create({
        model: MODELS.openai,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ],
    });
    const text = res.choices[0]?.message?.content;
    if (!text) throw new Error('OpenAI returned empty content');
    return text;
}

async function callGemini(apiKey: string, system: string, user: string, maxTokens: number): Promise<string> {
    const ai = new GoogleGenAI({ apiKey });
    const res = await ai.models.generateContent({
        model: MODELS.gemini,
        contents: user,
        config: {
            systemInstruction: system,
            temperature: 0,
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json',
        }
    });
    if (!res.text) throw new Error('Gemini returned empty content');
    return res.text;
}

interface ClaudeResponse {
    content?: { type: string; text?: string }[];
}

async function callClaude(apiKey: string, system: string, user: string, maxTokens: number): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: MODELS.claude, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Claude HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as ClaudeResponse;
    const text = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    if (!text) throw new Error('Claude returned empty content');
    return text;
}

const CALLERS: Record<AiProvider, (key: string, system: string, user: string, maxTokens: number) => Promise<string>> = {
    openai: callOpenAI,
    gemini: callGemini,
    claude: callClaude,
};

export function collectKeys(): ProviderKeys {
    return {
        openai: process.env.OPENAI_API_KEY || undefined,
        gemini: process.env.GEMINI_API_KEY || undefined,
        claude: process.env.CLAUDE_API_KEY || undefined,
    };
}

export function hasAnyAiKey(keys: ProviderKeys): boolean {
    return Boolean(keys.openai || keys.gemini || keys.claude);
}

/**
 * Tries `preferred` first (when configured and not 'auto'), then any other
 * configured provider, in a fixed order. Throws only if every configured
 * provider failed (or none are configured).
 */
export async function callJsonWithFallback(
    keys: ProviderKeys,
    preferred: AiProvider | 'auto',
    system: string,
    user: string,
    maxTokens = 900,
): Promise<ProviderResult> {
    const all: AiProvider[] = ['openai', 'gemini', 'claude'];
    const order: AiProvider[] =
        preferred === 'auto' ? all.filter((p) => keys[p]) : [preferred, ...all.filter((p) => p !== preferred && keys[p])];

    const errors: string[] = [];
    for (const provider of order) {
        const apiKey = keys[provider];
        if (!apiKey) continue;
        try {
            const text = await CALLERS[provider](apiKey, system, user, maxTokens);
            return { text, provider };
        } catch (err) {
            errors.push(`${provider}: ${(err as Error).message}`);
        }
    }
    throw new Error(`All configured AI providers failed: ${errors.join(' | ') || 'no provider keys configured'}`);
}

/** Pulls the first {...} JSON object out of a reply, tolerant of extra prose around it. */
export function extractJsonObject<T>(text: string): T | null {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1)) as T;
    } catch {
        return null;
    }
}