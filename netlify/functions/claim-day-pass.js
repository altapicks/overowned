// netlify/functions/claim-day-pass.js
//
// Free 24-hour trial flow. Customer submits email on the landing page; we:
//   1. Validate the email shape
//   2. Check license_stock for the 'day' tier (sold < available)
//   3. Reject if this email already has an active day-pass key
//   4. Generate a new license key (OO-XXXX-XXXX-XXXX-XXXX)
//   5. Insert into license_keys with plan='day', expires_at = now + 24h
//   6. Increment license_stock.sold for the 'day' tier
//   7. Email the user their key + 24h expiration + sign-in URL
//
// This replaces the previous Supabase magic-link flow — key auth lives on
// the app at app.overowned.io/sign-in?key=...
//
// Schema this depends on (see netlify/functions/_shared/README.md):
//   - public.license_keys (key, plan, status, email, expires_at, created_at, ...)
//   - public.license_stock (tier, available, sold, season, updated_at)

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { generateAccessKey } from './_shared/generate-key.js';
import { renderKeyEmail } from './_shared/render-key-email.js';

const TIER = 'day';
const PLAN = 'day';
const SEASON = '2026';
const DAY_PASS_DURATION_MS = 24 * 60 * 60 * 1000;
const APP_URL = 'https://app.overowned.io';
// Sign-in URL: matches the app's actual route. `next=%2F` sends the user
// to the dashboard root after they paste in the key shown in the email.
const SIGN_IN_PATH = '/signin';
const SIGN_IN_QUERY = '?next=%2F';
// Spam fix (Alta 2026-05-19): 'noreply@' from-addresses universally
// trigger spam filters at Gmail / Outlook / Yahoo. Real-looking
// addresses backed by SPF/DKIM/DMARC pass inbox checks. Switched to
// keys@ (a real receiving address — replies go to support@ via
// reply_to so we don't lose user replies).
const FROM_EMAIL = 'OverOwned <keys@overowned.io>';
const REPLY_TO = 'support@overowned.io';
// List-Unsubscribe header is REQUIRED by Gmail/Yahoo's 2024 bulk-
// sender rules — any transactional sender without it gets quietly
// scored down. Using mailto + one-click POST per RFC 8058 so Gmail
// can render a native unsubscribe button (which lowers spam votes).
const UNSUBSCRIBE_HEADERS = {
  'List-Unsubscribe': '<mailto:unsubscribe@overowned.io?subject=unsubscribe>',
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const resend = new Resend(process.env.RESEND_API_KEY);

function isValidEmail(s) {
  return typeof s === 'string'
    && s.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Sanity-check env config up front so logs show clear cause
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[claim-day-pass] Missing env: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return jsonError(500, 'Server configuration error. Please contact support.');
  }
  if (!process.env.RESEND_API_KEY) {
    console.error('[claim-day-pass] Missing env: RESEND_API_KEY');
    return jsonError(500, 'Server configuration error. Please contact support.');
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const email = (body.email || '').trim().toLowerCase();

    if (!isValidEmail(email)) {
      return jsonError(400, 'Please enter a valid email.');
    }

    // ── Inventory check ───────────────────────────────────────────────
    const { data: stock, error: stockErr } = await supabase
      .from('license_stock')
      .select('available, sold')
      .eq('tier', TIER)
      .eq('season', SEASON)
      .maybeSingle();
    if (stockErr) {
      console.error('[claim-day-pass] license_stock read failed', stockErr);
      return jsonError(500, 'Could not check inventory. Please try again.');
    }
    if (!stock) {
      console.error('[claim-day-pass] No license_stock row for tier=day season=' + SEASON);
      return jsonError(500, 'Day pass inventory not configured. Please contact support.');
    }
    if (stock.available !== null && stock.sold >= stock.available) {
      return jsonError(409, `All ${stock.available} day passes have been claimed. Season 1 Pass is still available above.`);
    }

    // ── Dedup: don't issue a second active key to the same email ──────
    const nowIso = new Date().toISOString();
    const { data: existingDayKey } = await supabase
      .from('license_keys')
      .select('key, expires_at')
      .eq('email', email)
      .eq('plan', PLAN)
      .eq('status', 'active')
      .gt('expires_at', nowIso)
      .maybeSingle();
    if (existingDayKey) {
      return jsonError(409, 'This email already has an active day pass. Check your inbox for your key.');
    }

    // Also block if this email is already a paid Season 1 holder
    const { data: existingSeasonKey } = await supabase
      .from('license_keys')
      .select('key')
      .eq('email', email)
      .eq('plan', 'season')
      .eq('status', 'active')
      .maybeSingle();
    if (existingSeasonKey) {
      return jsonError(409, 'This email already has Season 1 access. Check your inbox for your key.');
    }

    // ── Generate key (with one retry on the astronomically unlikely
    //    collision against the UNIQUE constraint)
    let accessKey, insertErr, attempts = 0;
    const expiresAt = new Date(Date.now() + DAY_PASS_DURATION_MS);
    while (attempts < 3) {
      accessKey = generateAccessKey();
      const { error } = await supabase
        .from('license_keys')
        .insert({
          key: accessKey,
          plan: PLAN,
          status: 'active',
          email,
          expires_at: expiresAt.toISOString(),
        });
      if (!error) { insertErr = null; break; }
      // 23505 = unique_violation — retry with a fresh key
      if (error.code !== '23505') { insertErr = error; break; }
      attempts++;
    }
    if (insertErr) {
      console.error('[claim-day-pass] license_keys insert failed', insertErr);
      return jsonError(500, 'Could not record your day pass. Please try again.');
    }

    // ── Also insert into licenses (the table active_access reads from).
    // user_id is left NULL — populated when the user first signs in via the
    // app-side /sign-in?key= handler.
    const { error: licenseErr } = await supabase
      .from('licenses')
      .insert({
        email,
        tier: 'day',
        status: 'active',
        expires_at: expiresAt.toISOString(),
        notes: `Day pass · key ${accessKey}`,
      });
    if (licenseErr) {
      // Non-fatal — key was created. Log and continue.
      console.error('[claim-day-pass] licenses insert failed (non-fatal)', licenseErr);
    }

    // ── Increment license_stock.sold atomically
    // Postgres-side: increment via SQL update so two simultaneous claims
    // can't both read sold=49 then both write sold=50. The .update with
    // a value derived from current state isn't truly atomic — for a
    // free trial this is acceptable, but the RPC version is in the README
    // if you want to lock it down.
    const { error: stockUpdateErr } = await supabase
      .from('license_stock')
      .update({
        sold: (stock.sold ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq('tier', TIER)
      .eq('season', SEASON);
    if (stockUpdateErr) {
      // Non-fatal — the key was created. Log and continue so the user still gets their email.
      console.error('[claim-day-pass] license_stock increment failed (non-fatal)', stockUpdateErr);
    }

    // ── Send the email ────────────────────────────────────────────────
    const signInUrl = `${APP_URL}${SIGN_IN_PATH}${SIGN_IN_QUERY}`;
    const { subject, html, text } = renderKeyEmail({
      key: accessKey,
      signInUrl,
      tier: 'day-pass',
      expiresAt,
    });
    try {
      await resend.emails.send({
        from: FROM_EMAIL,
        reply_to: REPLY_TO,
        to: email,
        subject,
        html,
        text,
        headers: UNSUBSCRIBE_HEADERS,
        tags: [{ name: 'category', value: 'access-key' }, { name: 'tier', value: 'day-pass' }],
      });
    } catch (mailErr) {
      console.error('[claim-day-pass] Resend send failed (key created, email NOT delivered)', mailErr);
      return jsonError(500, 'Your day pass was created but the email failed. Contact support@overowned.io with your email and we will resend it.');
    }

    return jsonOk({ ok: true });
  } catch (err) {
    console.error('[claim-day-pass] unhandled error', err);
    return jsonError(500, 'Something went wrong. Please try again.');
  }
};

function jsonOk(body)  { return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
function jsonError(statusCode, error) { return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error }) }; }
