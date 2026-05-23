import { Resend } from 'resend';
import { getTransactionReceipt, getPurchaseKeyFromTxHash } from './validate-key';

const POLAR_WEBHOOK_SECRET = process.env.POLAR_WEBHOOK_SECRET!;

export async function handleWebhook(event: any) {
  const webhookSecret = event.headers['x-polar-webhook-secret'];
  const purchaseId = event.body.purchase_id;
  const transactionHash = event.body.transaction_hash;

  if (webhookSecret !== POLAR_WEBHOOK_SECRET) {
    console.error('Invalid webhook secret');
    return { error: 'INVALID_WEBHOOK_SECRET', code: 401, message: 'Unauthorized' };
  }

  try {
    const receipt = await getTransactionReceipt(transactionHash);
    if (!receipt || receipt.status !== 'success') {
      console.error('Failed to retrieve transaction receipt');
      return { error: 'FAILED_TRANSACTION', code: 400, message: 'Transaction failed or not found' };
    }

    const purchaseKey = await getPurchaseKeyFromTxHash(transactionHash);
    if (!purchaseKey) {
      console.error('Failed to retrieve purchase key from transaction hash');
      return { error: 'MISSING_PURCHASE_KEY', code: 400, message: 'Missing purchase key' };
    }

    // Integrate Resend or Postmark to send the API key via email
    const resend = new Resend();
    await resend.sendEmail({
      from: 'no-reply@example.com',
      to: event.body.email,
      subject: 'Your Polar.sh API Key',
      text: `Hi there,\n\nYour Polar.sh API key is:\n${purchaseKey}\n\nPlease keep it secure.\n\nBest regards,\nPolar Team`,
    });

    return { error: null, code: 200, message: 'API key sent successfully' };
  } catch (error) {
    console.error('Error handling webhook', error);
    return { error: 'INTERNAL_SERVER_ERROR', code: 500, message: 'Internal server error' };
  }
}