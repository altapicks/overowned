// Netlify serverless function: create-checkout-session.js
//
// Called by landing page Subscribe buttons (weekly / monthly / season).
// Returns a Stripe Checkout Session URL. Frontend redirects the browser there.
//
// Flow:
//   1. Landing page POSTs { tier: 'weekly'|'monthly'|'season', email?: string } to this function
//   2. We map tier → Stripe price ID (from env vars)
//   3. Create a Checkout session with that price + success/cancel URLs
//   4. Return { url } — browser redirects
//
// After user pays, Stripe redirects them back to the `success_url` we set.
// The `stripe-webhook.js` function will also fire (async) to write the
// subscription row into Supabase — that's the source of truth.

const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const PRICE_MAP = {
  weekly:  process.env.STRIPE_PRICE_WEEKLY,
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  season:  process.env.STRIPE_PRICE_SEASON,
};

exports.handler = async (event) => {
  // CORS preflight — handle OPTIONS for cross-origin requests from app.overowned.io
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { tier, email, user_id } = JSON.parse(event.body || '{}');

    if (!tier || !PRICE_MAP[tier]) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'Invalid or missing tier. Use weekly|monthly|season.' }),
      };
    }

    const priceId = PRICE_MAP[tier];
    if (!priceId) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({ error: `Price ID not configured for tier: ${tier}` }),
      };
    }

    // Success URL: lands on landing page with ?checkout=success, which
    // our JS detects and redirects to app.overowned.io.
    // Cancel URL: returns to the pricing section of landing page.
    const successUrl = 'https://overowned.io/?checkout=success&session_id={CHECKOUT_SESSION_ID}';
    const cancelUrl  = 'https://overowned.io/?checkout=cancel#pricing';

    const sessionParams = {
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      // Store tier + user_id in metadata so the webhook knows which tier
      // was purchased and (if user was signed in) which Supabase user to attach.
      metadata: {
        tier,
        ...(user_id ? { supabase_user_id: user_id } : {}),
      },
      // Also attach to the subscription itself, because the subscription.updated
      // webhook event doesn't carry session metadata — it carries subscription metadata.
      subscription_data: {
        metadata: {
          tier,
          ...(user_id ? { supabase_user_id: user_id } : {}),
        },
      },
    };

    // Pre-fill customer email if we have it (signed-in user path).
    // If not, Stripe Checkout prompts them for it — that's also fine.
    if (email) sessionParams.customer_email = email;

    const session = await stripe.checkout.sessions.create(sessionParams);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ url: session.url, id: session.id }),
    };
  } catch (err) {
    console.error('[create-checkout-session]', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message || 'Internal error' }),
    };
  }
};

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };
}
