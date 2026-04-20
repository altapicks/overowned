// Netlify serverless function: stripe-webhook.js
//
// Receives webhook events from Stripe after payment/subscription changes.
// Verifies the signature (CRITICAL — without this, anyone could fake payment events).
// Writes subscription rows into Supabase.
//
// Events handled:
//   - checkout.session.completed      → new subscription, create/upsert row
//   - customer.subscription.updated   → period rollover, plan change, cancel_at_period_end
//   - customer.subscription.deleted   → subscription ended, mark as canceled
//
// The Supabase service_role key bypasses RLS, which is required because this
// function runs outside any user context.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  }
);

exports.handler = async (event) => {
  // CRITICAL: verify the signature so only real Stripe events are processed.
  // Netlify provides the raw body in event.body; the signature header is
  // called 'stripe-signature'.
  const signature = event.headers['stripe-signature'];
  if (!signature) {
    console.warn('[webhook] Missing stripe-signature header');
    return { statusCode: 400, body: 'Missing signature' };
  }

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] Signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook signature verification failed: ${err.message}` };
  }

  console.log(`[webhook] Received event: ${stripeEvent.type}`);

  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        await handleCheckoutCompleted(session);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = stripeEvent.data.object;
        await handleSubscriptionChange(subscription);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object;
        await handleSubscriptionDeleted(subscription);
        break;
      }
      default:
        console.log(`[webhook] Unhandled event type: ${stripeEvent.type}`);
    }
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('[webhook] Handler error:', err);
    // Return 500 so Stripe retries — this protects against transient DB errors.
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Handler: checkout.session.completed ─────────────────────────────────
// Fired when user completes payment. For subscriptions, Stripe then ALSO
// fires customer.subscription.created. We handle both for redundancy —
// whichever fires first, the subscription row gets populated.
async function handleCheckoutCompleted(session) {
  if (session.mode !== 'subscription') {
    console.log('[webhook] Skipping non-subscription checkout');
    return;
  }

  // Resolve the Supabase user. Two paths:
  //   1. User was signed in when purchasing → session.metadata.supabase_user_id is set
  //   2. User paid without signing in → we need to match by email
  const email = session.customer_email || session.customer_details?.email;
  let userId = session.metadata?.supabase_user_id;

  if (!userId && email) {
    userId = await findOrCreateUserByEmail(email);
  }

  if (!userId) {
    console.error('[webhook] Could not resolve user for session:', session.id, 'email:', email);
    return;
  }

  // Fetch the subscription to get period dates
  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  const tier = session.metadata?.tier || subscription.metadata?.tier || 'monthly';

  await upsertSubscription({
    user_id: userId,
    tier,
    status: subscription.status,
    stripe_customer_id: session.customer,
    stripe_subscription_id: subscription.id,
    current_period_start: toIso(subscription.current_period_start),
    current_period_end: toIso(subscription.current_period_end),
    cancel_at_period_end: subscription.cancel_at_period_end,
    locked_price_cents: subscription.items.data[0]?.price?.unit_amount || 0,
  });
}

// ── Handler: subscription created/updated ───────────────────────────────
async function handleSubscriptionChange(subscription) {
  // Get email from customer object (subscription event doesn't include it directly)
  const customer = await stripe.customers.retrieve(subscription.customer);
  const email = customer.email;

  let userId = subscription.metadata?.supabase_user_id;
  if (!userId && email) {
    userId = await findOrCreateUserByEmail(email);
  }
  if (!userId) {
    console.error('[webhook] Could not resolve user for subscription:', subscription.id);
    return;
  }

  const tier = subscription.metadata?.tier || 'monthly';

  await upsertSubscription({
    user_id: userId,
    tier,
    status: subscription.status,
    stripe_customer_id: subscription.customer,
    stripe_subscription_id: subscription.id,
    current_period_start: toIso(subscription.current_period_start),
    current_period_end: toIso(subscription.current_period_end),
    cancel_at_period_end: subscription.cancel_at_period_end,
    locked_price_cents: subscription.items.data[0]?.price?.unit_amount || 0,
  });
}

// ── Handler: subscription deleted ───────────────────────────────────────
async function handleSubscriptionDeleted(subscription) {
  const { error } = await supabase
    .from('subscriptions')
    .update({
      status: 'canceled',
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscription.id);
  if (error) console.error('[webhook] Failed to mark sub canceled:', error);
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function upsertSubscription(row) {
  row.updated_at = new Date().toISOString();
  const { error } = await supabase
    .from('subscriptions')
    .upsert(row, { onConflict: 'stripe_subscription_id' });
  if (error) {
    console.error('[webhook] Supabase upsert failed:', error);
    throw error;
  }
  console.log(`[webhook] Subscription upserted for user ${row.user_id}: ${row.status} / ${row.tier}`);
}

// Resolve Supabase auth user by email. If no user exists yet (user paid
// without signing up first), we create a Supabase user and send them a
// magic link so they can access the app. This is the "buy first, sign in
// after" flow.
async function findOrCreateUserByEmail(email) {
  // Look up existing user by email via the admin API
  const { data: existing, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) {
    console.error('[webhook] listUsers failed:', listErr);
    return null;
  }
  const match = existing?.users?.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
  if (match) return match.id;

  // Create a new user (no password — they'll sign in with magic link)
  const { data: created, error: createErr } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,  // skip the confirmation email, trust Stripe's email
  });
  if (createErr) {
    console.error('[webhook] createUser failed:', createErr);
    return null;
  }

  // Send a magic link so they can sign in
  try {
    await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: 'https://app.overowned.io' },
    });
  } catch (e) {
    console.warn('[webhook] magic link generation non-fatal error:', e.message);
  }

  return created?.user?.id || null;
}

function toIso(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}
