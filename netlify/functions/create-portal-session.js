// Netlify serverless function: create-portal-session.js
//
// Called when a subscribed user clicks "Manage subscription" in the app.
// Creates a Stripe Customer Portal session so they can update card, cancel,
// view invoices, etc. Returns the URL; browser redirects there.
//
// Stripe's Customer Portal is free, hosted, and required by Stripe ToS
// for recurring subscriptions (gives users self-service).

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

exports.handler = async (event) => {
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
    const { user_id } = JSON.parse(event.body || '{}');
    if (!user_id) {
      return jsonError(400, 'Missing user_id');
    }

    // Look up the user's stripe_customer_id from the subscriptions table
    const { data: sub, error } = await supabase
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user_id)
      .order('current_period_end', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return jsonError(500, error.message);
    if (!sub?.stripe_customer_id) {
      return jsonError(404, 'No Stripe customer found for this user');
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: 'https://app.overowned.io',
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ url: portalSession.url }),
    };
  } catch (err) {
    console.error('[create-portal-session]', err);
    return jsonError(500, err.message || 'Internal error');
  }
};

function jsonError(status, message) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: message }),
  };
}
