// Groq API — OpenAI-compatible REST endpoint
const API_KEY = import.meta.env.VITE_GROQ_API_KEY;
const MODEL = 'llama-3.3-70b-versatile';
const FALLBACK_MODEL = 'llama-3.1-8b-instant';
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const MAX_DOC_CHARS = 25000;

function truncateText(text) {
  if (text.length <= MAX_DOC_CHARS) return text;
  const half = Math.floor(MAX_DOC_CHARS / 2);
  return text.slice(0, half) +
    '\n\n[... DOCUMENT TRUNCATED FOR PROCESSING ...]\n\n' +
    text.slice(-half);
}

const SYSTEM_PROMPT = `You are DocGuard AI, a legal document analyzer. You simplify complex legal documents into clear, easy-to-understand language.

IMPORTANT: You must respond ONLY with valid JSON. No markdown, no code fences, no extra text.

When given a legal document, respond with this exact JSON structure:
{
  "documentTitle": "string - detected title of the document",
  "documentType": "string - type like Rental Agreement, Employment Contract, etc.",
  "safetyScore": number between 0-100 (100 = perfectly safe),
  "clauses": [
    {
      "id": number,
      "title": "string - short clause title",
      "originalText": "string - the exact original clause text from the document",
      "explanation": "string - plain language explanation, no jargon",
      "userImpact": "string - what this specifically means for the person signing",
      "risk": "safe" | "caution" | "risky",
      "warning": "string or null - if risky/caution, explain WHY with a warning prefix"
    }
  ],
  "missingProtections": [
    "string - each missing protection or safeguard that SHOULD be in this type of document"
  ],
  "summary": "string - starting with 'By signing this document, you are agreeing to...' covering all key obligations, risks, and financial impacts"
}

Rules:
- Break the ENTIRE document into clauses, don't skip any
- Be thorough but concise in explanations
- Use extremely simple, everyday human language (easily understandable by a common villager from India with no formal education).
- Actively look for loopholes, hidden traps, and red flags. Be brutally honest.
- Be honest about risks - if something is unfair, say so
- safetyScore: 80-100 = safe document, 50-79 = proceed with caution, 0-49 = high risk
- Identify ALL risky or unfair terms
- Check for missing protections like: exit clauses, penalty caps, dispute resolution, privacy protections, liability limits, termination notice periods
- Do NOT provide legal advice, only explain and simplify`;

const CHAT_PROMPT = `You are DocGuard AI. The user previously uploaded a legal document and you analyzed it. They now have a follow-up question. Answer conversationally, clearly, and without legal jargon. Keep responses concise. Do NOT provide legal advice - only explain and simplify. Reference specific clauses when relevant.`;

function repairJSON(raw) {
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in AI response');
  s = s.substring(start);

  try { return JSON.parse(s); } catch {}

  s = s.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s); } catch {}

  s = s.replace(/,\s*"[^"]*$/, '');
  s = s.replace(/,\s*"[^"]*":\s*"[^"]*$/, '');
  s = s.replace(/,\s*"[^"]*":\s*\{[^}]*$/, '');
  s = s.replace(/,\s*$/, '');

  const opens = { '{': 0, '[': 0 };
  for (const ch of s) {
    if (ch === '{') opens['{']++;
    else if (ch === '}') opens['{']--;
    else if (ch === '[') opens['[']++;
    else if (ch === ']') opens['[']--;
  }
  for (let i = 0; i < opens['[']; i++) s += ']';
  for (let i = 0; i < opens['{']; i++) s += '}';

  s = s.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s); } catch {}

  throw new Error('Could not repair AI JSON response — try a shorter document or retry');
}

// Sleep helper
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Groq API call with auto-retry on 429
async function groqFetch(systemPrompt, userMessage, temperature = 0.3, maxTokens = 8192, retries = 3, jsonMode = true) {
  if (!API_KEY) throw new Error('Add VITE_GROQ_API_KEY to your .env file');

  const models = [MODEL, FALLBACK_MODEL];

  for (const model of models) {
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      temperature,
      max_tokens: maxTokens,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          body: JSON.stringify(body),
        });

        if (res.ok) {
          const data = await res.json();
          const text = data.choices?.[0]?.message?.content;
          if (!text) throw new Error('Empty response from AI');
          return text;
        }

        const errBody = await res.text().catch(() => '');
        console.error(`Groq error (${model}, attempt ${attempt + 1}):`, res.status, errBody);

        if (res.status === 429) {
          // Rate limited — wait and retry
          const waitSec = Math.pow(2, attempt) * 2; // 2s, 4s, 8s
          console.warn(`Rate limited. Waiting ${waitSec}s before retry...`);
          await sleep(waitSec * 1000);
          continue;
        }

        // Non-429 error — try next model
        break;
      } catch (err) {
        if (err.message === 'Empty response from AI') throw err;
        console.error(`Fetch error (${model}, attempt ${attempt + 1}):`, err);
        if (attempt < retries - 1) {
          await sleep(2000);
          continue;
        }
        break;
      }
    }
  }

  throw new Error('All AI models failed. Please wait a minute and try again.');
}

// Groq API call for vision (image analysis) — uses a vision-capable model
async function groqVisionFetch(systemPrompt, textPrompt, base64DataUrl, temperature = 0.3, maxTokens = 8192, retries = 3) {
  if (!API_KEY) throw new Error('Add VITE_GROQ_API_KEY to your .env file');

  // Use llama-3.2-90b-vision-preview for image analysis, fallback to 11b
  const visionModels = ['llama-3.2-90b-vision-preview', 'llama-3.2-11b-vision-preview'];

  for (const model of visionModels) {
    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: textPrompt },
            { type: 'image_url', image_url: { url: base64DataUrl } }
          ]
        }
      ],
      temperature,
      max_tokens: maxTokens,
    };

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`,
          },
          body: JSON.stringify(body),
        });

        if (res.ok) {
          const data = await res.json();
          const text = data.choices?.[0]?.message?.content;
          if (!text) throw new Error('Empty response from AI');
          return text;
        }

        const errBody = await res.text().catch(() => '');
        console.error(`Groq Vision error (${model}, attempt ${attempt + 1}):`, res.status, errBody);

        if (res.status === 429) {
          const waitSec = Math.pow(2, attempt) * 2;
          console.warn(`Rate limited. Waiting ${waitSec}s before retry...`);
          await sleep(waitSec * 1000);
          continue;
        }
        break;
      } catch (err) {
        if (err.message === 'Empty response from AI') throw err;
        console.error(`Vision fetch error (${model}, attempt ${attempt + 1}):`, err);
        if (attempt < retries - 1) {
          await sleep(2000);
          continue;
        }
        break;
      }
    }
  }

  throw new Error('All vision models failed. Please wait a minute and try again.');
}

export async function analyzeDocument(text) {
  const truncatedText = truncateText(text);
  const raw = await groqFetch(
    SYSTEM_PROMPT,
    'Analyze this legal document:\n\n' + truncatedText,
    0.3, 8192
  );
  return repairJSON(raw);
}

export async function analyzeImage(base64DataUrl) {
  const raw = await groqVisionFetch(
    SYSTEM_PROMPT + '\n\nAnalyze the legal document shown in this image. Read ALL the text carefully, including any text in regional Indian languages (Kannada, Hindi, Tamil, etc). Translate and analyze everything.',
    'Analyze this legal document image:',
    base64DataUrl,
    0.3, 8192
  );
  return repairJSON(raw);
}

export async function chatFollowUp(documentContext, chatHistory, question) {
  const ctx = `Document: ${documentContext.documentTitle}\nType: ${documentContext.documentType}\nScore: ${documentContext.safetyScore}/100\nClauses: ${documentContext.clauses.length}\nRisks: ${documentContext.clauses.filter(c=>c.risk!=='safe').map(c=>c.title).join(', ')}`;

  const fullPrompt = CHAT_PROMPT + '\n\nDocument context:\n' + ctx +
    '\n\nPrevious conversation:\n' +
    chatHistory.map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${m.text}`).join('\n') +
    '\n\nUser question: ' + question;

  const raw = await groqFetch(
    CHAT_PROMPT,
    fullPrompt,
    0.5, 1024, 3, false
  );
  return raw;
}

export async function translateAnalysis(analysis, targetLanguage) {
  const TRANSLATE_PROMPT = `You are a professional translator. Translate the given JSON content into ${targetLanguage}.

CRITICAL RULES:
1. Respond ONLY with valid JSON — no markdown, no code fences, no extra text.
2. Keep ALL JSON keys/field names EXACTLY as they are in English (documentTitle, clauses, explanation, etc.)
3. Translate ONLY the string VALUES into ${targetLanguage}
4. Keep numbers, booleans, and the "risk" field values ("safe", "caution", "risky") in English
5. Translate naturally — use simple, everyday ${targetLanguage} that anyone can understand
6. The output JSON must have the EXACT same structure as the input`;

  const raw = await groqFetch(
    TRANSLATE_PROMPT,
    'Translate this legal analysis JSON into ' + targetLanguage + ':\n\n' + JSON.stringify(analysis),
    0.3, 8192
  );
  return repairJSON(raw);
}
