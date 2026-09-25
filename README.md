# BidWisely – African Procurement Matcher & AI Agent

> **AI-powered procurement intelligence for African SMEs.**  
> Discover Nigerian tenders, extract structured data via GPT-4o-mini, match opportunities to your business profile, and receive an executive briefing — all in one live Actor run.

---

## What It Does

African SMEs lose billions in potential contracts every year because procurement information is **scattered across hundreds of portals, PDFs, and government websites**. BidWisely solves this with a single, end-to-end Actor that:

1. **Crawls** Nigerian public procurement portals (BPP, NoCoPo, Lagos PPA, GlobalTenders, eTenders, and more)
2. **Extracts** structured tender fields (title, buyer, category, location, deadline, contract value, requirements) using **GPT-4o-mini**
3. **Matches** each opportunity against your SME profile with a **transparent, weighted scoring engine**
4. **Acts** as an AI Agent — ranking opportunities, flagging urgent deadlines, and generating an **actionable executive briefing** saved to the Key-Value Store

```
Procurement Portals
      ↓
  CheerioCrawler
      ↓
  GPT-4o-mini Extraction
      ↓
  Weighted Matching Engine
      ↓
  Dataset (Matched Tenders)
      ↓
  AI Agent Briefing (KV Store)
```

---

## Input Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `startUrls` | Array | ✅ | Procurement portal listing URLs to crawl |
| `aiProvider` | String | – | AI provider to use: `openai`, `gemini`, or `claude` (default: `openai`) |
| `aiApiKey` | String (secret) | – | Your API key for the selected provider |
| `aiModel` | String | – | (Optional) Override the default model (e.g. `gemini-1.5-flash-latest`) |
| `smeProfile` | Object | ✅ | Your business profile (see shape below) |
| `maxItems` | Integer | – | Max tender pages to process (default: 10) |
| `maxRequestsPerCrawl` | Integer | – | Hard cap on total HTTP requests (default: 200) |
| `keywords` | Array of strings | – | Only process pages containing these keywords |
| `enableAiExtraction` | Boolean | – | Use AI to extract structured fields. When disabled, totally ignores AI and falls back to a fast heuristic extractor (no API charges). (default: true) |

### SME Profile Shape

```json
{
  "industry": "Construction",
  "location": "Lagos",
  "capacity": 20000000,
  "certifications": ["CAC", "Tax Clearance"],
  "services": ["Building and Construction Services", "Renovation"],
  "experience": ["Construction Projects", "Government Contracts"]
}
```

---

## Sample Output — Dataset Item

```json
{
  "title": "Provision of Catering Services for Staff Canteen",
  "buyer": "Federal Ministry of Finance",
  "category": "Catering",
  "location": "Lagos",
  "deadline": "2026-10-15",
  "contractValue": "₦18,000,000",
  "contractValueMax": 18000000,
  "requirements": [
    "CAC registration",
    "Tax clearance certificate"
  ],
  "sourceUrl": "https://www.globaltenders.com/nigeria-tenders/12345",
  "publishedAt": "2026-09-24T19:30:00.000Z",
  "extractionSource": "gemini",
  "matchScore": 90,
  "matchLabel": "Excellent Match 🟢",
  "matchBasis": "industry (35%), location (25%), capacity (20%), certifications (10%), keywords (10%)",
  "matchChecks": {
    "industry": true,
    "location": true,
    "capacity": true,
    "certifications": true,
    "keywords": true
  },
  "matchExplanation": "Match score: 90% based on industry, location, capacity, certifications, keywords. Passed 5/5 criteria. No immediate gaps detected.",
  "missingRequirements": []
}
```

---

## Sample AI Agent Briefing (Key-Value Store: `AGENT_SUMMARY` & `ALL_OPPORTUNITIES`)

At the end of the run, the Actor writes two files to your Key-Value Store:
1. `ALL_OPPORTUNITIES.json`: A full dump of every tender processed, separating the `opportunityDetails` from the `matchingConclusion`.
2. `AGENT_SUMMARY.json`: An AI-generated executive briefing.

```json
{
  "generatedAt": "2026-09-24T20:01:23.456Z",
  "totalOpportunities": 8,
  "topMatches": [
    {
      "title": "Provision of Catering Services for Staff Canteen",
      "matchScore": 90,
      "matchLabel": "Excellent Match 🟢",
      "deadline": "2026-10-15",
      "contractValue": "₦18,000,000"
    }
  ],
  "aiGenerated": true,
  "aiProvider": "gemini",
  "urgentDeadlines": [],
  "briefing": "Your top opportunity is the Federal Ministry of Finance catering tender at ₦18M — a near-perfect match. You hold all required certifications and your capacity comfortably covers the value. Recommended next steps: (1) Download the full RFP from the source URL, (2) Prepare your CAC and tax clearance certificates for submission, (3) Submit a competitive bid by 15 October. Two other partial matches in Abuja may require location flexibility..."
}
```

---

## Pricing — Pay-Per-Event (PPE)

BidWisely uses **Pay-Per-Event** monetisation on the Apify Store. You only pay for the work actually done, making it incredibly cost-effective.

| Event | Price per 1,000 | Triggered When |
|---|---|---|
| `apify-actor-start` *(synthetic)* | \$0.01 | Actor run starts |
| `ai-extraction` | \$0.50 | AI structures one opportunity. **(Skipped if `enableAiExtraction` is false or you provide your own API key)** |
| `agent-insight` | \$1.00 | The AI Agent generates the actionable executive briefing |
| `apify-default-dataset-item` *(synthetic)* | \$0.01 | Each matched record pushed to the dataset |

### Example cost for a typical run (1,000 opportunities)

- Actor Start → \$0.00001
- 1,000 AI extractions (without own key) → \$0.50
- 1 actionable insight briefing → \$0.001
- 1,000 dataset item results → \$0.01
- **Total ≈ \$0.51** for 1,000 fully matched, AI-briefed procurement opportunities!

> Set `ACTOR_MAX_TOTAL_CHARGE_USD` in your run configuration to cap your total spend.

---

## Use Cases

| Who | How They Use BidWisely |
|---|---|
| **African SMEs** | Daily scan for new tenders matching their profile; instant match score tells them where to focus |
| **Procurement Consultants** | Run on behalf of multiple clients (different `smeProfile` per run) to identify opportunities |
| **NGOs & Development Orgs** | Monitor for grant/service contracts in their sector |
| **Government Agencies** | Audit procurement transparency by tracking what's published across portals |
| **Researchers** | Build datasets of Nigerian procurement activity for policy analysis |

---

## Scheduling — Continuous Intelligence

Set up an **Apify Scheduler** to run BidWisely automatically:

- **Daily** at 08:00 WAT → fresh morning briefing
- **Twice weekly** for lower-volume SMEs

Every run pushes new tenders to the dataset and overwrites `AGENT_SUMMARY` with the latest briefing.

---

## FAQ

**Q: Do I need to provide my own OpenAI API key?**  
A: Yes. Your key is marked as `isSecret` in the input schema — it's never logged or stored by BidWisely. You can also set `enableAiExtraction: false` to use the heuristic extractor (free, but less accurate).

**Q: Why CheerioCrawler and not Playwright?**  
A: Most Nigerian procurement portals serve static HTML. CheerioCrawler is ~10× faster and cheaper than a browser crawler. Playwright would only be needed for JavaScript-heavy SPAs.

**Q: Can I add more portals?**  
A: Yes — simply add more URLs to `startUrls`. BidWisely's universal link-detection strategy adapts to any HTML structure.

**Q: What happens if a page blocks the crawler?**  
A: Requests are retried up to 3 times. Add Apify Proxy to your run configuration (Residential proxies) to bypass blocks on government portals.

**Q: Is my API key safe?**  
A: The `isSecret: true` flag prevents it from appearing in logs. It's stored only in the Actor's input for the duration of the run.

**Q: How accurate is the matching?**  
A: The match score is a **relevance indicator**, not a win prediction. It shows how well the opportunity aligns with your stated profile. Always read the full tender before bidding.

---

## Project Structure

```
.actor/
├── actor.json          # Actor metadata, memory bounds, categories
├── input_schema.json   # Input validation & Apify Console form
├── output_schema.json  # Dataset + KV Store output links
└── dataset_schema.json # Output tab column definitions
src/
├── main.ts             # Entry point: input validation, crawler setup, agent trigger
├── routes.ts           # Cheerio router: LISTING + DETAIL handlers
├── extractor.ts        # AI (GPT-4o-mini) + heuristic extraction
├── matcher.ts          # Weighted scoring engine
├── agent.ts            # AI Agent: ranking, briefing, KV Store save
└── types.ts            # Shared TypeScript interfaces
Dockerfile              # Container image
```

---

## Quick Start

### Step 1 — Install dependencies

```bash
npm install
```

### Step 2 — Add your API key

**Option A — `.env` file ✅ recommended for local development**

Create a `.env` file in the project root (already in `.gitignore` — won't be committed) and add the key for your preferred provider:

```
OPENAI_API_KEY=sk-your-key-here
# or
GEMINI_API_KEY=AIzaSy...
# or 
CLAUDE_API_KEY=sk-ant-api03...
```

The Apify SDK loads this automatically when you run `apify run`.

**Option B — directly in `INPUT.json`**

Add it directly to your `storage/key_value_stores/default/INPUT.json` along with your provider selection:

```json
{ 
  "aiProvider": "gemini",
  "aiApiKey": "AIzaSy..." 
}
```

**Option C — No API key (Heuristic Mode)**

Set `"enableAiExtraction": false` in your input. The Actor will completely bypass all AI operations, avoiding API keys and charges altogether. It will use the fast regex-based heuristic extractor — highly scalable but less accurate.

---

### Step 3 — Set up your local input

Create `storage/key_value_stores/default/INPUT.json` (omit `aiApiKey` if you used Option A):

```json
{
  "startUrls": [
    { "url": "https://www.globaltenders.com/nigeria-tenders" },
    { "url": "https://etenders.com.ng/" }
  ],
  "smeProfile": {
    "industry": "Construction",
    "location": "Lagos",
    "capacity": 20000000,
    "certifications": ["CAC", "Tax Clearance"],
    "services": ["Building and Construction Services", "Renovation"]
  },
  "maxItems": 5,
  "enableAiExtraction": true,
  "aiProvider": "gemini"
}
```

### Step 4 — Run locally

```bash
apify run
```

### Step 5 — Deploy to Apify

```bash
apify login   # enter your Apify API token when prompted
apify push    # builds and deploys to the Cloud
```

---

## Integrations

Use the Apify API to trigger BidWisely from your backend:

```javascript
import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: 'YOUR_APIFY_TOKEN' });

const run = await client.actor('YOUR_USERNAME/bidwisely-procurement-matcher').call({
  startUrls: [{ url: 'https://www.globaltenders.com/nigeria-tenders' }],
  openAiApiKey: process.env.OPENAI_API_KEY,
  smeProfile: { industry: 'IT Services', location: 'Abuja', capacity: 50000000 },
  maxItems: 20,
});

const { items } = await client.dataset(run.defaultDatasetId).listItems();
const summary = await client.keyValueStore(run.defaultKeyValueStoreId).getRecord('AGENT_SUMMARY');

console.log(`Found ${items.length} matched opportunities`);
console.log('AI Briefing:', summary.value.briefing);
```

---

*Built for the Apify Hackathon. BidWisely — because every Nigerian SME deserves a fair shot at public contracts.*
