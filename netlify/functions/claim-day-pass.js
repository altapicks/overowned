// netlify/functions/claim-day-pass.js
//
// Free 24-hour trial flow. Customer submits email on the landing page;
// we:
//   1. Validate the email shape
//   2. Check Day Pass inventory (50 per season)
//   3. Reject if this email already redeemed a Day Pass for this season
//   4. Create / look up the Supabase user
//   5. Record the day_pass row with expires_at = now + 24h
//   6. Send a Supabase magic link to app.overowned.io
//
// We use Supabase's built-in magic-link generation (admin.generateLink)
// rather than triggering signInWithOtp from the client, because we need
// to record the day_pass row server-side BEFORE the link is sent —
// otherwise an attacker could spam the form.

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const DAY_PASS_TOTAL = 50;
const SEASON = 1;
const DAY_PASS_DURATION_HOURS = 24;
const APP_URL = 'https://app.overowned.io';
const FROM_EMAIL = 'OverOwned <noreply@overowned.io>';
const REPLY_TO = 'support@overowned.io';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);
const resend = new Resend(process.env.RESEND_API_KEY);

// Lightweight server-side email check — same shape rule the client uses.
function isValidEmail(s) {
  return typeof s === 'string'
    && s.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const email = (body.email || '').trim().toLowerCase();

    if (!isValidEmail(email)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Please enter a valid email.' }),
      };
    }

    // ── Inventory check ───────────────────────────────────────────────
    const { count: usedCount } = await supabase
      .from('day_passes')
      .select('id', { count: 'exact', head: true })
      .eq('season', SEASON);
    if ((usedCount ?? 0) >= DAY_PASS_TOTAL) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'All 50 day passes have been claimed. Season 1 Pass is still available above.' }),
      };
    }

    // ── Dedup check ───────────────────────────────────────────────────
    const { data: existingDayPass } = await supabase
      .from('day_passes')
      .select('id')
      .eq('email', email)
      .eq('season', SEASON)
      .maybeSingle();
    if (existingDayPass) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'This email has already claimed a day pass for Season 1.' }),
      };
    }

    // ── Also block if this email is already a paid Season 1 holder ────
    const { data: existingSeasonPass } = await supabase
      .from('season_passes')
      .select('id')
      .eq('email', email)
      .eq('season', SEASON)
      .in('status', ['active', 'pending'])
      .maybeSingle();
    if (existingSeasonPass) {
      return {
        statusCode: 409,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'This email already has Season 1 access. Check your inbox for your sign-in link.' }),
      };
    }

    // ── Generate Supabase magic link ──────────────────────────────────
    // generateLink with type=magiclink creates a link that, when clicked,
    // signs the user in and redirects to redirectTo. Supabase auto-creates
    // the user if they don't exist.
    const { data: linkData, error: linkErr } = await supabase.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: APP_URL },
    });
    if (linkErr || !linkData?.properties?.action_link) {
      console.error('generateLink failed', linkErr);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Could not create sign-in link. Please try again.' }),
      };
    }
    const magicLink = linkData.properties.action_link;
    const userId = linkData.user?.id;

    // ── Record the day pass ───────────────────────────────────────────
    // expires_at is set when the user FIRST signs in (handled app-side).
    // For now we record it as null and let the app populate it on first
    // session creation. status='granted' means link sent but not redeemed.
    const { error: insertErr } = await supabase
      .from('day_passes')
      .insert({
        email,
        season: SEASON,
        user_id: userId ?? null,
        granted_at: new Date().toISOString(),
        expires_at: null,                 // set on first sign-in
        status: 'granted',
      });
    if (insertErr) {
      console.error('day_pass insert failed', insertErr);
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Could not record your day pass. Please try again.' }),
      };
    }

    // ── Send the email via Resend ─────────────────────────────────────
    await resend.emails.send({
      from: FROM_EMAIL,
      reply_to: REPLY_TO,
      to: email,
      subject: 'Your OverOwned 24-hour Day Pass',
      html: dayPassEmailHtml(magicLink),
      text: dayPassEmailText(magicLink),
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error('claim-day-pass error', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Something went wrong. Please try again.' }),
    };
  }
};

function dayPassEmailHtml(link) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>OverOwned Day Pass</title></head>
<body style="margin:0;padding:0;background:#0A1628;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#0A1628;padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="520" style="max-width:520px;background:#0F1D33;border:1px solid #1E2D4A;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:32px 32px 16px;">
          <div style="font-size:22px;font-weight:800;color:#FFFFFF;letter-spacing:-0.5px;">
            Over<span style="color:#F5C518;">O</span>wned
          </div>
        </td></tr>
        <tr><td style="padding:0 32px 8px;">
          <h1 style="margin:0 0 12px;font-size:24px;color:#FFFFFF;font-weight:700;letter-spacing:-0.5px;line-height:1.3;">
            Your 24-hour day pass is ready.
          </h1>
          <p style="margin:0 0 20px;color:#8B9ABA;font-size:15px;line-height:1.6;">
            Click the button below to sign in. Your trial starts the moment you sign in and runs for 24 hours.
          </p>
        </td></tr>
        <tr><td align="center" style="padding:8px 32px 24px;">
          <a href="${link}" style="display:inline-block;padding:14px 32px;background:#F5C518;color:#0A1628;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;">
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
          <p style="margin:0 0 8px;color:#5F728F;font-size:12px;line-height:1.6;">
            This link expires in 1 hour. If it expires before you click it, just request another day pass at <a href="https://overowned.io" style="color:#F5C518;text-decoration:none;">overowned.io</a>.
          </p>
          <p style="margin:0;color:#5F728F;font-size:12px;line-height:1.6;">
            Didn't request this? You can safely ignore this email.
          </p>
        </td></tr>
      </table>
      <p style="margin:20px 0 0;color:#5F728F;font-size:11px;text-align:center;">
        © 2026 OverOwned · <a href="https://overowned.io/terms.html" style="color:#5F728F;">Terms</a> · <a href="https://overowned.io/privacy.html" style="color:#5F728F;">Privacy</a>
      </p>
    </td></tr>
  </table>
</body></html>`;
}

function dayPassEmailText(link) {
  return `OverOwned — Your 24-hour day pass is ready.

Click this link to sign in:
${link}

Your trial runs for 24 hours from your first sign-in.

This sign-in link expires in 1 hour.

— OverOwned
https://overowned.io`;
}
