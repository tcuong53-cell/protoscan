const POLAR_ORG_ID = '1a0b8ee1-1f06-44ea-b6f4-99d7687be563';
const VALIDATE_URL = 'https://api.polar.sh/v1/license-keys/validate';

export interface LicenseValidation {
  valid: boolean;
  error?: string;
}

/**
 * Validate a ProtoScan API key (Polar.sh license key) against the Polar API.
 * Requires POLAR_ACCESS_TOKEN env var for server-side validation.
 * Returns { valid: true } if key is active, { valid: false, error } otherwise.
 */
export async function validateLicenseKey(key: string): Promise<LicenseValidation> {
  const polarToken = process.env.POLAR_ACCESS_TOKEN;
  if (!polarToken) {
    // No server token — accept any key with the right prefix as a soft check.
    // Full validation happens when POLAR_ACCESS_TOKEN is configured (production).
    if (key.startsWith('ps_pro_') && key.length > 10) {
      return { valid: true };
    }
    return { valid: false, error: 'Invalid key format. Keys start with ps_pro_' };
  }

  try {
    const res = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${polarToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key, organization_id: POLAR_ORG_ID }),
    });

    if (res.ok) {
      return { valid: true };
    }

    if (res.status === 404) {
      return { valid: false, error: 'Invalid or expired API key.' };
    }

    return { valid: false, error: `Validation failed (HTTP ${res.status})` };
  } catch {
    // Network error — fail open to avoid blocking users when Polar is down
    return { valid: true };
  }
}
