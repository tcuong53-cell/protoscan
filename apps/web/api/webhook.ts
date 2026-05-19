import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash, randomBytes } from 'node:crypto';
import { createHmac } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;
const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET!;

// Credit mapping for Polar products
const PRODUCT_CREDITS: Record<string, number> = {
  'protoscan-vision-100': 100,
  'protoscan-vision-500': 500,
  'protoscan-vision-unlimited': 99999,
};
const DEFAULT_CREDITS = 100;

function verifyPolarSignature(body: string, signature: string | undefined): boolean {
  if (!signature || !POLAR_WEBHOOK_SECRET) return false;
  const expected = createHmac('sha256', POLAR_WEBHOOK_SECRET).update(body).digest('hex');
  return signature === expected || signature === `sha256=${expected}`;
}

function generateApiKey(): { key: string; hash: string; prefix: string } {
  const raw = randomBytes(24).toString('hex');
  const key = `ps_live_${raw}`;
  const hash = createHash('sha256').update(key).digest('hex');
  const prefix = `ps_live_${raw.slice(0, 8)}`;
  return { key, hash, prefix };
}

async function supabasePost(path: string, body: unknown) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(body),
  });
}

async function supabasePatch(path: string, body: unknown) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(body),
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Verify webhook signature
  const rawBody = JSON.stringify(req.body);
  const signature = req.headers['x-polar-signature'] as string | undefined
    ?? req.headers['webhook-signature'] as string | undefined;

  if (!verifyPolarSignature(rawBody, signature)) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  // 2. Parse Polar webhook payload
  const event = req.body as {
    type: string;
    data: {
      customer_email?: string;
      email?: string;
      product_id?: string;
      product?: { id?: string };
      amount?: number;
      id?: string;
    };
  };

  // Only handle checkout completed events
  if (event.type !== 'checkout.completed' && event.type !== 'order.created') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  const email = event.data.customer_email ?? event.data.email;
  const productId = event.data.product_id ?? event.data.product?.id ?? 'unknown';
  const amountCents = event.data.amount ?? 0;
  const checkoutId = event.data.id ?? `polar_${Date.now()}`;
  const creditsToAdd = PRODUCT_CREDITS[productId] ?? DEFAULT_CREDITS;

  if (!email) {
    return res.status(400).json({ error: 'No customer email in webhook payload' });
  }

  // 3. Upsert user
  const existingUserRes = await fetch(
    `${SUPABASE_URL}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=id`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    },
  );
  const existingUsers = await existingUserRes.json() as Array<{ id: string }>;

  let userId: string;
  if (existingUsers.length > 0) {
    userId = existingUsers[0].id;
  } else {
    const newUserRes = await supabasePost('users', { email });
    const newUsers = await newUserRes.json() as Array<{ id: string }>;
    userId = newUsers[0].id;
  }

  // 4. Check for existing active key
  const existingKeyRes = await fetch(
    `${SUPABASE_URL}/rest/v1/api_keys?user_id=eq.${userId}&revoked_at=is.null&select=id,credits_remaining`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    },
  );
  const existingKeys = await existingKeyRes.json() as Array<{ id: string; credits_remaining: number }>;

  let apiKeyPlaintext: string | undefined;

  if (existingKeys.length > 0) {
    // Add credits to existing key
    await supabasePatch(`api_keys?id=eq.${existingKeys[0].id}`, {
      credits_remaining: existingKeys[0].credits_remaining + creditsToAdd,
    });
  } else {
    // Generate new key
    const { key, hash, prefix } = generateApiKey();
    apiKeyPlaintext = key;
    await supabasePost('api_keys', {
      user_id: userId,
      key_hash: hash,
      key_prefix: prefix,
      credits_remaining: creditsToAdd,
    });
  }

  // 5. Record payment
  await supabasePost('payments', {
    user_id: userId,
    polar_checkout_id: checkoutId,
    amount_cents: amountCents,
    credits_added: creditsToAdd,
    product_id: productId,
  });

  return res.status(200).json({
    ok: true,
    credits_added: creditsToAdd,
    ...(apiKeyPlaintext ? { api_key: apiKeyPlaintext } : {}),
  });
}
