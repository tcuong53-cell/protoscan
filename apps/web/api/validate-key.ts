import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const token = auth.slice(7);
  const keyHash = hashKey(token);

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked_at=is.null&select=id,credits_remaining,user_id,users(email)`,
    {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    },
  );

  if (!response.ok) {
    return res.status(500).json({ error: 'Failed to validate key' });
  }

  const rows = await response.json() as Array<{
    id: string;
    credits_remaining: number;
    user_id: string;
    users: { email: string };
  }>;

  if (!rows.length) {
    return res.status(401).json({ error: 'Invalid or revoked API key' });
  }

  const key = rows[0];
  return res.status(200).json({
    valid: true,
    credits_remaining: key.credits_remaining,
    email: key.users.email,
  });
}
