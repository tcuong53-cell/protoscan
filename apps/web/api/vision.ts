import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB base64 (~3.75 MB image)

const SYSTEM_PROMPT = `You are a UX visual analyst. Analyze this Figma screen screenshot and identify visual UX issues.

Return a JSON array of findings. Each finding has:
- category: "vision-contrast" | "vision-clarity" | "vision-empty-state" | "vision-overload"
- severity: "high" | "medium" | "low"
- message: brief description of the issue
- area: where on the screen (e.g., "top CTA button", "card list area")

Rules:
- Return ONLY a JSON array, no markdown, no explanation
- Maximum 3 findings per screen
- Only flag genuine issues, not style preferences`;

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// Best-effort in-memory rate limiter (per function instance).
// Not reliable on Vercel serverless (resets on cold start) — serves as a soft guard only.
// For production scale, move to Supabase or Vercel KV.
const rateLimiter = new Map<string, number[]>();
function checkRateLimit(keyId: string, rpm: number): boolean {
  const now = Date.now();
  const window = 60_000;
  const timestamps = rateLimiter.get(keyId) ?? [];
  const recent = timestamps.filter((t) => now - t < window);
  if (recent.length >= rpm) return false;
  recent.push(now);
  rateLimiter.set(keyId, recent);
  return true;
}

// Vercel body size limit
export const config = { api: { bodyParser: { sizeLimit: '5mb' } } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Extract and validate token
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header. Pass your ProtoScan API key.' });
  }

  const token = auth.slice(7);
  const keyHash = hashKey(token);

  // 2. Validate key in Supabase
  const keyResponse = await fetch(
    `${SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked_at=is.null&select=id,credits_remaining,rate_limit_rpm`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    },
  );

  if (!keyResponse.ok) {
    return res.status(500).json({ error: 'Failed to validate API key' });
  }

  const keys = await keyResponse.json() as Array<{
    id: string;
    credits_remaining: number;
    rate_limit_rpm: number;
  }>;

  if (!keys.length) {
    return res.status(401).json({ error: 'Invalid or expired API key' });
  }

  const apiKey = keys[0];

  if (apiKey.credits_remaining <= 0) {
    return res.status(402).json({ error: 'No vision credits remaining. Purchase more at https://github.com/oxxo/protoscan#pro' });
  }

  // 3. Rate limit (best-effort, per-instance)
  if (!checkRateLimit(apiKey.id, apiKey.rate_limit_rpm)) {
    return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
  }

  // 4. Parse and validate request body
  const { image, screenName } = req.body as { image?: string; screenName?: string };
  if (!image) {
    return res.status(400).json({ error: 'Missing "image" field (base64 PNG)' });
  }
  if (image.length > MAX_IMAGE_SIZE) {
    return res.status(413).json({ error: `Image too large. Max ${MAX_IMAGE_SIZE / 1024 / 1024} MB.` });
  }

  // 5. Atomically decrement credits BEFORE calling OpenAI
  const decrementRes = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/decrement_credits`,
    {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_key_id: apiKey.id }),
    },
  );

  if (!decrementRes.ok) {
    return res.status(500).json({ error: 'Failed to process credits' });
  }

  const remaining = await decrementRes.json() as number;
  if (remaining < 0) {
    // Atomic check failed — no credits available (race condition prevented)
    return res.status(402).json({ error: 'No vision credits remaining.' });
  }

  // 6. Call OpenAI with ProtoScan's key
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 500,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Analyze this screen: "${screenName ?? 'Unknown'}"` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${image}`, detail: 'low' } },
          ],
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '[]';
    let findings: unknown[];
    try {
      findings = JSON.parse(raw);
    } catch {
      findings = [];
    }

    return res.status(200).json({ findings });
  } catch (error) {
    // Refund the credit since OpenAI failed — user shouldn't pay for failed analysis
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/refund_credit`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_key_id: apiKey.id }),
    }).catch(() => {}); // best-effort refund

    // Sanitize error — don't leak OpenAI internals to client
    console.error(`Vision analysis failed for key ${apiKey.id}:`, error instanceof Error ? error.message : error);
    return res.status(500).json({ error: 'Vision analysis failed. Please try again.' });
  }
}
