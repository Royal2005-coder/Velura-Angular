import fs from 'node:fs';

// Deployment must stop when configured secrets cannot reach the intended API project.
// Values stay in request bodies and are never included in output or CLI arguments.
const keys = [
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STOREFRONT_ORIGIN', 'API_PUBLIC_ORIGIN',
  'VNPAY_TMN_CODE', 'VNPAY_HASH_SECRET', 'VNPAY_PAYMENT_URL',
  'MOMO_PARTNER_CODE', 'MOMO_ACCESS_KEY', 'MOMO_SECRET_KEY', 'MOMO_API_ORIGIN',
  'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER', 'ESMS_API_KEY', 'ESMS_SECRET_KEY',
  'ESMS_BRANDNAME', 'ESMS_SMS_TYPE', 'ESMS_SANDBOX',
];

try {
  const token = process.env.VERCEL_TOKEN;
  const { projectId, orgId } = JSON.parse(fs.readFileSync('apps/api/.vercel/project.json', 'utf8'));
  if (!token || !projectId || !orgId) throw new Error('Missing Vercel API deployment identity.');
  for (const required of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']) {
    if (!process.env[required]?.trim()) throw new Error(`Missing required payment configuration: ${required}.`);
  }
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (!value) continue;
    const response = await fetch(`https://api.vercel.com/v10/projects/${encodeURIComponent(projectId)}/env?teamId=${encodeURIComponent(orgId)}&upsert=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value, type: 'encrypted', target: ['production'] }),
    });
    if (!response.ok) throw new Error(`Unable to configure ${key}: HTTP ${response.status}. Deployment stopped.`);
    console.log(`Configured ${key} for the production API.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Production environment synchronization failed.');
  process.exitCode = 1;
}
