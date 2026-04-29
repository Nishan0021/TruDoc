// OpenRouter API
const API_KEY = import.meta.env.VITE_OPENROUTER_API_KEY;
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'google/gemini-2.5-flash'; // cheap & fast; change if needed

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
  // Strip markdown code fences
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  // Extract from first { to end
  const start = s.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in AI response');
  s = s.substring(start);

  // Try parsing as-is first
  try { return JSON.parse(s); } catch {}

  // Fix trailing commas before ] or }
  s = s.replace(/,\s*([}\]])/g, '$1');

  // Try again
  try { return JSON.parse(s); } catch {}

  // Response was likely truncated — close open brackets/braces
  // Remove any incomplete last value (trailing string without closing quote, etc.)
  s = s.replace(/,\s*"[^"]*$/, '');        // incomplete key
  s = s.replace(/,\s*"[^"]*":\s*"[^"]*$/, ''); // incomplete key:value string
  s = s.replace(/,\s*"[^"]*":\s*\{[^}]*$/, ''); // incomplete nested object
  s = s.replace(/,\s*$/, '');               // trailing comma

  // Count open vs close brackets
  const opens = { '{': 0, '[': 0 };
  const closeMap = { '{': '}', '[': ']' };
  for (const ch of s) {
    if (ch === '{') opens['{']++;
    else if (ch === '}') opens['{']--;
    else if (ch === '[') opens['[']++;
    else if (ch === ']') opens['[']--;
  }

  // Append missing closers (arrays first, then objects)
  for (let i = 0; i < opens['[']; i++) s += ']';
  for (let i = 0; i < opens['{']; i++) s += '}';

  // Final trailing-comma cleanup and parse
  s = s.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s); } catch {}

  throw new Error('Could not repair AI JSON response — try a shorter document or retry');
}

async function openRouterFetch(messages, temperature = 0.3, maxTokens = 16384) {
  if (!API_KEY) throw new Error('Add VITE_OPENROUTER_API_KEY to your .env file');

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'DocGuard'
    },
    body: JSON.stringify({ model: MODEL, messages, temperature, max_tokens: maxTokens })
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('OpenRouter error:', res.status, errBody);
    let msg = `API error ${res.status}`;
    try { const parsed = JSON.parse(errBody); msg = parsed.error?.message || msg; } catch {}
    throw new Error(msg);
  }
  return await res.json();
}

export async function analyzeDocument(text) {
  const data = await openRouterFetch([
    { role: 'user', content: SYSTEM_PROMPT + '\n\nHere is the legal document to analyze:\n\n' + text }
  ], 0.3, 8192);

  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty response from AI');

  return repairJSON(raw);
}

export async function analyzeImage(base64DataUrl) {
  const data = await openRouterFetch([
    {
      role: 'user',
      content: [
        { type: 'text', text: SYSTEM_PROMPT + '\n\nAnalyze the legal document shown in this image. Read ALL the text carefully, including any text in regional Indian languages (Kannada, Hindi, Tamil, etc). Translate and analyze everything.' },
        { type: 'image_url', image_url: { url: base64DataUrl } }
      ]
    }
  ], 0.3, 8192);

  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty response from AI');

  return repairJSON(raw);
}

export async function chatFollowUp(documentContext, chatHistory, question) {
  const ctx = `Document: ${documentContext.documentTitle}\nType: ${documentContext.documentType}\nScore: ${documentContext.safetyScore}/100\nClauses: ${documentContext.clauses.length}\nRisks: ${documentContext.clauses.filter(c=>c.risk!=='safe').map(c=>c.title).join(', ')}`;

  const messages = [
    { role: 'system', content: CHAT_PROMPT + '\n\nDocument context:\n' + ctx },
    ...chatHistory.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text })),
    { role: 'user', content: question }
  ];

  const data = await openRouterFetch(messages, 0.5, 2048);
  return data.choices?.[0]?.message?.content || "Sorry, couldn't respond.";
}
