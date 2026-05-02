// netlify/functions/stripe-webhook.js
//
// Receives Stripe webhook events. Specifically watches:
//   - checkout.session.completed     → grant Season Pass + send magic link
//   - charge.refunded               → mark season pass as refunded (lose access)
//
// Webhook signature is verified using STRIPE_WEBHOOK_SECRET. Without a
// valid signature, the request is rejected — this is critical, because
// otherwise anyone who guesses the URL could grant themselves a Season
// Pass.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const SEASON = 1;
const SEASON_EXPIRES_AT = '2026-07-12T23:59:59-04:00';   // EDT, end of July 12
const APP_URL = 'https://app.overowned.io';
const FROM_EMAIL = 'OverOwned <noreply@overowned.io>';
const REPLY_TO = 'overowneddfs@gmail.com';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const resend = new Resend(process.env.RESEND_API_KEY);

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!sig || !webhookSecret) {
    console.error('Missing webhook signature or secret');
    return { statusCode: 400, body: 'Missing signature' };
  }

  // Stripe needs the raw body for signature verification — Netlify
  // passes it as event.body. We use Stripe's constructEvent which throws
  // on invalid signatures.
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(stripeEvent.data.object);
        break;
      case 'charge.refunded':
        await handleChargeRefunded(stripeEvent.data.object);
        break;
      default:
        // No-op for events we don't care about. Stripe will retry
        // failed events; returning 200 stops retries for ignored types.
        break;
    }
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error(`Webhook handler failed for ${stripeEvent.type}`, err);
    // Return 500 so Stripe retries — we want to recover from transient
    // Supabase / Resend errors.
    return { statusCode: 500, body: 'Handler error' };
  }
};

async function handleCheckoutCompleted(session) {
  const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();
  if (!email) {
    console.error('checkout.session.completed missing email', session.id);
    return;
  }

  // ── Idempotency: if we already recorded this checkout, do nothing.
  // Stripe occasionally re-delivers webhook events; without this, a
  // re-delivery could grant duplicate passes or send duplicate emails.
  const { data: existing } = await supabase
    .from('season_passes')
    .select('id, status')
    .eq('stripe_checkout_session_id', session.id)
    .maybeSingle();
  if (existing) {
    console.log(`Idempotent skip — session ${session.id} already processed`);
    return;
  }

  // ── Generate the magic link FIRST so user creation is atomic.
  // Supabase auto-creates the user if they don't exist.
  const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: APP_URL },
  });
  if (linkErr || !linkData?.properties?.action_link) {
    console.error('generateLink failed for paid checkout', linkErr);
    throw new Error('Failed to generate sign-in link');
  }
  const magicLink = linkData.properties.action_link;
  const userId = linkData.user?.id;

  // ── Record the season pass.
  const { error: insertErr } = await supabase
    .from('season_passes')
    .insert({
      email,
      season: SEASON,
      user_id: userId ?? null,
      stripe_checkout_session_id: session.id,
      stripe_customer_id: session.customer,
      stripe_payment_intent_id: session.payment_intent,
      amount_paid: session.amount_total,
      currency: session.currency,
      purchased_at: new Date().toISOString(),
      expires_at: SEASON_EXPIRES_AT,
      status: 'active',
    });
  if (insertErr) {
    console.error('season_pass insert failed', insertErr);
    throw new Error('Failed to record season pass');
  }

  // ── Send welcome + magic-link email.
  await resend.emails.send({
    from: FROM_EMAIL,
    reply_to: REPLY_TO,
    to: email,
    subject: 'Welcome to OverOwned Season 1',
    html: seasonPassEmailHtml(magicLink),
    text: seasonPassEmailText(magicLink),
  });

  console.log(`Season 1 pass granted: ${email}`);
}

async function handleChargeRefunded(charge) {
  // charge.payment_intent links back to the season pass we recorded.
  const paymentIntentId = charge.payment_intent;
  if (!paymentIntentId) return;

  const { error } = await supabase
    .from('season_passes')
    .update({
      status: 'refunded',
      refunded_at: new Date().toISOString(),
    })
    .eq('stripe_payment_intent_id', paymentIntentId)
    .eq('status', 'active');
  if (error) {
    console.error('season_pass refund update failed', error);
    throw new Error('Failed to mark season pass as refunded');
  }
  console.log(`Season pass refunded: payment_intent=${paymentIntentId}`);
}

// ── Email templates ───────────────────────────────────────────────────

function seasonPassEmailHtml(link) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Welcome to OverOwned</title></head>
<body style="margin:0;padding:0;background:#0A1628;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0A1628;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="520" style="max-width:520px;background:#0F1D33;border:1px solid #F5C518;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:32px 32px 16px;">
          <div style="font-size:22px;font-weight:800;color:#FFFFFF;letter-spacing:-0.5px;">
            Over<span style="color:#F5C518;">O</span>wned
          </div>
          <div style="display:inline-block;margin-top:14px;padding:4px 12px;background:#F5C518;color:#0A1628;font-size:10px;font-weight:800;letter-spacing:1.5px;border-radius:100px;">
            SEASON 1
          </div>
        </td></tr>
        <tr><td style="padding:0 32px 8px;">
          <h1 style="margin:0 0 12px;font-size:26px;color:#FFFFFF;font-weight:700;letter-spacing:-0.5px;line-height:1.3;">
            Welcome to Season 1.
          </h1>
          <p style="margin:0 0 20px;color:#8B9ABA;font-size:15px;line-height:1.6;">
            Your Season 1 pass is active until <strong style="color:#FFFFFF;">11:59 PM ET on July 12, 2026</strong>. Click below to sign in — full product access, all slates, every projection.
          </p>
        </td></tr>
        <tr><td align="center" style="padding:8px 32px 24px;">
          <a href="${link}" style="display:inline-block;padding:14px 36px;background:#F5C518;color:#0A1628;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">
            Sign in to OverOwned
          </a>
        </td></tr>
        <tr><td style="padding:0 32px 24px;">
          <p style="margin:0;color:#5F728F;font-size:12px;line-height:1.6;">
            Or paste this URL into your browser:<br>
            <span style="color:#8B9ABA;word-break:break-all;">${link}</span>
          </p>
        </td></tr>
        <tr><td style="padding:24px 32px;border-top:1px solid #1E2D4A;">
          <p style="margin:0 0 12px;color:#FFFFFF;font-size:14px;font-weight:600;">
            What's inside:
          </p>
          <ul style="margin:0 0 12px 20px;padding:0;color:#8B9ABA;font-size:13px;line-height:1.8;">
            <li>Real projections for every DK and PrizePicks slate</li>
            <li>Live leverage and trap detection</li>
            <li>Lineup optimizer with DK CSV export</li>
            <li>Direct line for questions — just reply to this email</li>
          </ul>
        </td></tr>
        <tr><td style="padding:18px 32px 24px;border-top:1px solid #1E2D4A;">
          <p style="margin:0;color:#5F728F;font-size:11px;line-height:1.6;">
            Sign-in link expires in 1 hour. If it expires, request another at <a href="https://app.overowned.io" style="color:#F5C518;text-decoration:none;">app.overowned.io</a>. Sessions stay active for 30 days — no constant re-logins on mobile.
          </p>
        </td></tr>
      </table>
      <p style="margin:20px 0 0;color:#5F728F;font-size:11px;text-align:center;">
        © 2026 OverOwned · <a href="https://overowned.io/terms.html" style="color:#5F728F;">Terms</a> · <a href="https://overowned.io/privacy.html" style="color:#5F728F;">Privacy</a> · <a href="https://overowned.io/refund.html" style="color:#5F728F;">Refund Policy</a>
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function seasonPassEmailText(link) {
  return `Welcome to OverOwned Season 1.

Your pass is active until 11:59 PM ET on July 12, 2026.

Sign in here:
${link}

What's inside:
• Real projections for every DK and PrizePicks slate
• Live leverage and trap detection
• Lineup optimizer with DK CSV export
• Direct line for questions — just reply to this email

Sign-in link expires in 1 hour. Sessions stay active for 30 days.

— OverOwned
https://overowned.io`;
}
