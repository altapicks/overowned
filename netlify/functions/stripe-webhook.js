// netlify/functions/stripe-webhook.js
//
// Receives Stripe webhook events. Specifically watches:
//   - checkout.session.completed  → grant Season 1 license key + email it
//   - charge.refunded             → mark license key as refunded (revokes access)
//
// Webhook signature is verified using STRIPE_WEBHOOK_SECRET. Without a
// valid signature, the request is rejected — this is critical, because
// otherwise anyone who guesses the URL could grant themselves a Season Pass.
//
// Replaces the previous Supabase magic-link flow — keys live in
// public.license_keys and are validated by app.overowned.io/sign-in?key=...

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { generateAccessKey } from './_shared/generate-key.js';
import { renderKeyEmail } from './_shared/render-key-email.js';

const TIER = 'season';
const PLAN = 'season';
const SEASON = '2026';
const SEASON_EXPIRES_AT = '2026-07-12T23:59:59-04:00'; // EDT, end of July 12
const APP_URL = 'https://app.overowned.io';
const SIGN_IN_PATH = '/sign-in';
const FROM_EMAIL = 'OverOwned <noreply@overowned.io>';
const REPLY_TO = 'support@overowned.io';

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
    console.error('[stripe-webhook] Missing webhook signature or secret');
    return { statusCode: 400, body: 'Missing signature' };
  }

  // Stripe needs the raw body for signature verification — Netlify
  // passes it as event.body. constructEvent throws on invalid signatures.
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed', err.message);
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
        // No-op for events we don't care about. Returning 200 stops retries.
        break;
    }
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error(`[stripe-webhook] handler failed for ${stripeEvent.type}`, err);
    // 500 so Stripe retries — recover from transient Supabase / Resend errors.
    return { statusCode: 500, body: 'Handler error' };
  }
};

/* ────────────────────────────────────────────────────────────────────
   checkout.session.completed → grant Season 1 license key
   ──────────────────────────────────────────────────────────────────── */
async function handleCheckoutCompleted(session) {
  const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();
  if (!email) {
    console.error('[stripe-webhook] checkout.session.completed missing email', session.id);
    return;
  }

  // ── Idempotency: if this email already has an active season key, skip.
  // Stripe occasionally re-delivers webhook events; without this guard, a
  // re-delivery would grant duplicate keys + send duplicate emails.
  //
  // TODO (recommended): add a `stripe_session_id` column to license_keys
  // and index it UNIQUE so we can dedup by Stripe event rather than email.
  const { data: existingKey } = await supabase
    .from('license_keys')
    .select('key')
    .eq('email', email)
    .eq('plan', PLAN)
    .eq('status', 'active')
    .maybeSingle();
  if (existingKey) {
    console.log(`[stripe-webhook] Idempotent skip — ${email} already has season key ${existingKey.key}`);
    return;
  }

  // ── Inventory check (best-effort — Stripe charge is already captured)
  const { data: stock } = await supabase
    .from('license_stock')
    .select('available, sold')
    .eq('tier', TIER)
    .eq('season', SEASON)
    .maybeSingle();
  if (stock && stock.available !== null && stock.sold >= stock.available) {
    // Oversold — log loudly. We still grant the key because the customer
    // already paid; refund handling is manual at this point.
    console.error(`[stripe-webhook] OVERSOLD: ${email} purchased after ${stock.available} cap. Granting anyway — review and refund manually if needed.`);
  }

  // ── Generate key (retry on extremely-unlikely UNIQUE collision)
  let accessKey, insertErr, attempts = 0;
  while (attempts < 3) {
    accessKey = generateAccessKey();
    const { error } = await supabase
      .from('license_keys')
      .insert({
        key: accessKey,
        plan: PLAN,
        status: 'active',
        email,
        expires_at: SEASON_EXPIRES_AT,
      });
    if (!error) { insertErr = null; break; }
    if (error.code !== '23505') { insertErr = error; break; }
    attempts++;
  }
  if (insertErr) {
    console.error('[stripe-webhook] license_keys insert failed', insertErr);
    throw new Error('Failed to record season key');
  }

  // ── Also insert into licenses (the table active_access reads from).
  // We store stripe_pi_id so refunds can resolve directly back to this row.
  const { error: licenseErr } = await supabase
    .from('licenses')
    .insert({
      email,
      tier: 'season',
      status: 'active',
      purchased_at: new Date().toISOString(),
      expires_at: SEASON_EXPIRES_AT,
      stripe_pi_id: session.payment_intent,
      notes: `Season 1 · key ${accessKey}`,
    });
  if (licenseErr) {
    // Non-fatal — key was created and charge already captured.
    console.error('[stripe-webhook] licenses insert failed (non-fatal)', licenseErr);
  }

  // ── Increment license_stock.sold
  const newSold = (stock?.sold ?? 0) + 1;
  const { error: stockErr } = await supabase
    .from('license_stock')
    .update({ sold: newSold, updated_at: new Date().toISOString() })
    .eq('tier', TIER)
    .eq('season', SEASON);
  if (stockErr) {
    console.error('[stripe-webhook] license_stock increment failed (non-fatal)', stockErr);
  }

  // ── Send welcome + key email
  const signInUrl = `${APP_URL}${SIGN_IN_PATH}?key=${encodeURIComponent(accessKey)}`;
  const { subject, html, text } = renderKeyEmail({
    key: accessKey,
    signInUrl,
    tier: 'season-1',
    expiresAt: new Date(SEASON_EXPIRES_AT),
  });
  await resend.emails.send({
    from: FROM_EMAIL,
    reply_to: REPLY_TO,
    to: email,
    subject,
    html,
    text,
  });

  console.log(`[stripe-webhook] Season 1 key granted: ${email} → ${accessKey}`);
}

/* ────────────────────────────────────────────────────────────────────
   charge.refunded → revoke license access
   ──────────────────────────────────────────────────────────────────── */
async function handleChargeRefunded(charge) {
  const piId = charge.payment_intent;
  if (!piId) return;

  // Primary path: find the licenses row by stripe_pi_id, get the email,
  // mark both licenses + license_keys refunded.
  const { data: licenseRow } = await supabase
    .from('licenses')
    .select('id, email')
    .eq('stripe_pi_id', piId)
    .eq('status', 'active')
    .maybeSingle();

  let email = licenseRow?.email;

  // Fallback: if licenses row wasn't found (old data, manual entry, etc),
  // resolve email via the Stripe PaymentIntent → Customer chain.
  if (!email) {
    try {
      const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['customer'] });
      email = (pi.receipt_email || pi.customer?.email || '').toLowerCase();
    } catch (err) {
      console.error('[stripe-webhook] failed to retrieve PaymentIntent for refund', piId, err);
      return;
    }
  }
  if (!email) {
    console.error('[stripe-webhook] refund could not resolve customer email', piId);
    return;
  }

  // Mark the active license row(s) refunded
  if (licenseRow) {
    await supabase
      .from('licenses')
      .update({ status: 'refunded', updated_at: new Date().toISOString() })
      .eq('id', licenseRow.id);
  } else {
    await supabase
      .from('licenses')
      .update({ status: 'refunded', updated_at: new Date().toISOString() })
      .eq('email', email)
      .eq('tier', TIER)
      .eq('status', 'active');
  }

  // Mark the active season key(s) for this email as refunded.
  const { data: updated, error } = await supabase
    .from('license_keys')
    .update({ status: 'refunded' })
    .eq('email', email)
    .eq('plan', PLAN)
    .eq('status', 'active')
    .select('key');
  if (error) {
    console.error('[stripe-webhook] license_keys refund update failed', error);
    throw new Error('Failed to mark key as refunded');
  }

  // Also decrement license_stock.sold so the inventory frees up.
  const { data: stock } = await supabase
    .from('license_stock')
    .select('sold')
    .eq('tier', TIER)
    .eq('season', SEASON)
    .maybeSingle();
  if (stock && stock.sold > 0 && updated && updated.length > 0) {
    await supabase
      .from('license_stock')
      .update({ sold: stock.sold - updated.length, updated_at: new Date().toISOString() })
      .eq('tier', TIER)
      .eq('season', SEASON);
  }

  console.log(`[stripe-webhook] Refunded ${updated?.length || 0} key(s) for ${email} (pi=${piId})`);
}
