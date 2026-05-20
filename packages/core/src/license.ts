const POLAR_ORG_ID = '1a0b8ee1-1f06-44ea-b6f4-99d7687be563';
const VALIDATE_URL = 'https://api.polar.sh/v1/customer-portal/license-keys/validate';

export interface LicenseValidation {
  valid: boolean;
  error?: string;
}

/**
 * Validate a ProtoScan API key (Polar.sh license key) against the public
 * customer-portal endpoint. No server-side token needed — the endpoint
 * accepts organization_id + key directly.
 *
 * Fail-closed: network errors return invalid (user must be online to validate).
 */
export async function validateLicenseKey(key: string): Promise<LicenseValidation> {
  if (!key || key.length < 5) {
    return { valid: false, error: 'Invalid key format.' };
  }

  try {
    const res = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, organization_id: POLAR_ORG_ID }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      return { valid: true };
    }

    if (res.status === 404) {
      return { valid: false, error: 'Invalid or expired API key.' };
    }

    return { valid: false, error: `Validation failed (HTTP ${res.status})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Unable to verify license — check your network connection. (${msg})` };
  }
}
