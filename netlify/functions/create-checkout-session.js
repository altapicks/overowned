// netlify/functions/create-checkout-session.js
//
// Creates a Stripe Checkout session for the Season 1 Pass.
// Inventory check happens both here (pre-flight) and in the webhook
// (post-payment), so a sold-out attempt can't even reach Stripe.
//
// On success, returns { url } pointing to Stripe's hosted checkout.
// The customer's email is collected by Stripe and used as the canonical
// identity for the magic-link sign-in.

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const SEASON_1_TOTAL = 25;
const STRIPE_PRICE_LOOKUP_KEY = 'season_1';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // ── 1. Inventory check ───────────────────────────────────────────────
    const { count } = await supabase
      .from('season_passes')
      .select('id', { count: 'exact', head: true })
      .eq('season', 1)
      .in('status', ['active', 'pending']);

    const used = count ?? 0;
    if (used >= SEASON_1_TOTAL) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Season 1 is sold out. Season 2 coming soon.' }),
      };
    }

    // ── 2. Resolve the Stripe price by lookup_key ───────────────────────
    // Using lookup_key keeps the code season-agnostic — when Season 2
    // ships, just create a `season_2` price in Stripe and bump the
    // STRIPE_PRICE_LOOKUP_KEY constant above.
    const prices = await stripe.prices.list({
      lookup_keys: [STRIPE_PRICE_LOOKUP_KEY],
      active: true,
      limit: 1,
    });
    const price = prices.data[0];
    if (!price) {
      console.error(`No active Stripe price with lookup_key=${STRIPE_PRICE_LOOKUP_KEY}`);
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Pricing configuration error.' }),
      };
    }

    // ── 3. Build the Checkout session ───────────────────────────────────
    const origin = event.headers.origin || 'https://overowned.io';
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{ price: price.id, quantity: 1 }],
      // Customer's email is what we'll use for the magic link.
      // Stripe collects it natively and we receive it on the webhook.
      customer_creation: 'always',
      // Success URL has ?checkout=success so the landing page knows to
      // show the "check your email" message and clean the query string.
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel#pricing`,
      // Surface the legal links in Stripe's checkout footer.
      consent_collection: {
        terms_of_service: 'required',
      },
      custom_text: {
        terms_of_service_acceptance: {
          message: 'I agree to the OverOwned [Terms of Service](https://overowned.io/terms.html) and [Refund Policy](https://overowned.io/refund.html).',
        },
        submit: {
          message: 'Season 1 access expires July 12, 2026. One-time payment.',
        },
      },
      // Metadata flows through to the webhook so we know which season this is.
      metadata: { season: '1' },
      // Tax — let Stripe Tax handle if enabled in your dashboard.
      automatic_tax: { enabled: false },
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('create-checkout-session error', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Checkout temporarily unavailable.' }),
    };
  }
};
