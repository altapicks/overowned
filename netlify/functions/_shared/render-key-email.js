// netlify/functions/_shared/render-key-email.js
//
// One shared, parameterized email template used for both:
//   - Day Pass  (24-hour trial)
//   - Season 1  (paid pass through July 12, 2026)
//
// Returns { subject, html, text } so callers can:
//   const { subject, html, text } = renderKeyEmail({...});
//   await resend.emails.send({ ..., subject, html, text });
//
// Visual: matches the landing page's home tab — dark navy (#06111f),
// gold accent (#ffd11a), Inter family with system fallbacks. Table-based
// layout with inline styles for cross-client safety (Gmail, Outlook,
// Apple Mail). No external assets.

const BRAND_BG       = '#06111f';
const PANEL_BG       = '#102339';
const PANEL_BORDER   = 'rgba(138, 170, 210, 0.18)';
const TEXT           = '#f6f8fc';
const MUTED          = '#8ea0bb';
const MUTED_2        = '#60718c';
const GOLD           = '#ffd11a';
const GOLD_SOFT      = 'rgba(255, 209, 26, 0.10)';
const GOLD_RING      = 'rgba(255, 209, 26, 0.36)';
const FONT_STACK     = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
const MONO_STACK     = `'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'Courier New', monospace`;

/**
 * Render the OverOwned access key email.
 *
 * @param {object} opts
 * @param {string} opts.key         - The access key, e.g. "OO-A4F2-9X3K-B7M1-Q8R5"
 * @param {string} opts.signInUrl   - Full sign-in URL, e.g. "https://app.overowned.io/sign-in?key=OO-..."
 * @param {string} opts.tier        - 'season-1' or 'day-pass'
 * @param {Date|string} [opts.expiresAt] - When the access expires (Date or ISO string).
 *                                          Day Pass: leave undefined (starts on first sign-in).
 */
export function renderKeyEmail({ key, signInUrl, tier, expiresAt }) {
  const isSeasonPass = tier === 'season-1';

  const subject     = isSeasonPass
    ? 'Welcome to OverOwned Season 1 — your access key inside'
    : 'Your OverOwned 24-hour day pass — access key inside';

  const tierBadge   = isSeasonPass ? 'SEASON 1' : 'DAY PASS';
  const headline    = isSeasonPass
    ? 'Welcome to Season 1.'
    : 'Your 24-hour day pass is ready.';
  const subhead     = isSeasonPass
    ? 'Full Season 1 access — every projection, every slate, through Wimbledon.'
    : 'Full product access for 24 hours, starting the moment you sign in.';

  const expirationLabel = isSeasonPass
    ? 'Active until July 12, 2026 · 11:59 PM ET'
    : 'Expires 24 hours after first sign-in';

  return {
    subject,
    html: htmlBody({ key, signInUrl, tierBadge, headline, subhead, expirationLabel }),
    text: textBody({ key, signInUrl, tierBadge, headline, subhead, expirationLabel }),
  };
}

/* ── HTML template ──────────────────────────────────────────────────── */

function htmlBody({ key, signInUrl, tierBadge, headline, subhead, expirationLabel }) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Your OverOwned access key</title>
</head>
<body style="margin:0;padding:0;background:${BRAND_BG};font-family:${FONT_STACK};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;">

  <!-- Preheader (hidden, shows in inbox preview) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;color:${BRAND_BG};opacity:0;">
    Your access key: ${escapeHtml(key)} — ${escapeHtml(expirationLabel)}
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${BRAND_BG};padding:40px 16px;">
    <tr><td align="center">

      <!-- Card -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:${PANEL_BG};border:1px solid ${PANEL_BORDER};border-radius:16px;overflow:hidden;">

        <!-- Brand + tier badge -->
        <tr><td style="padding:28px 32px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td align="left" style="font-size:20px;font-weight:800;color:${TEXT};letter-spacing:-0.4px;">
                Over<span style="color:${GOLD};">O</span>wned
              </td>
              <td align="right" style="padding-left:12px;">
                <span style="display:inline-block;padding:5px 12px;background:${GOLD};color:${BRAND_BG};font-size:10px;font-weight:800;letter-spacing:1.6px;border-radius:999px;">
                  ${escapeHtml(tierBadge)}
                </span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Headline + subhead -->
        <tr><td style="padding:18px 32px 6px;">
          <h1 style="margin:0 0 10px;font-size:26px;font-weight:800;color:${TEXT};letter-spacing:-0.6px;line-height:1.18;">
            ${escapeHtml(headline)}
          </h1>
          <p style="margin:0;color:${MUTED};font-size:15px;line-height:1.55;">
            ${escapeHtml(subhead)}
          </p>
        </td></tr>

        <!-- Access key chip -->
        <tr><td style="padding:24px 32px 8px;">
          <div style="font-size:10px;font-weight:700;color:${MUTED_2};letter-spacing:1.8px;text-transform:uppercase;margin-bottom:10px;">
            Your Access Key
          </div>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr><td style="background:${GOLD_SOFT};border:1px solid ${GOLD_RING};border-radius:12px;padding:18px 20px;text-align:center;">
              <span style="font-family:${MONO_STACK};font-size:20px;font-weight:700;color:${GOLD};letter-spacing:3px;">${escapeHtml(key)}</span>
            </td></tr>
          </table>
          <div style="margin-top:10px;font-size:11px;color:${MUTED_2};letter-spacing:0.4px;">
            ${escapeHtml(expirationLabel)}
          </div>
        </td></tr>

        <!-- CTA -->
        <tr><td align="center" style="padding:22px 32px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="background:${GOLD};border-radius:10px;">
              <a href="${escapeAttr(signInUrl)}"
                 style="display:inline-block;padding:14px 32px;color:${BRAND_BG};text-decoration:none;font-size:15px;font-weight:800;letter-spacing:0.2px;font-family:${FONT_STACK};">
                Sign in to OverOwned →
              </a>
            </td></tr>
          </table>
        </td></tr>

        <!-- Fallback URL -->
        <tr><td style="padding:12px 32px 28px;">
          <p style="margin:0;color:${MUTED_2};font-size:11px;line-height:1.6;">
            Or paste your key at <a href="https://app.overowned.io" style="color:${GOLD};text-decoration:none;">app.overowned.io</a>:<br>
            <span style="color:${MUTED};word-break:break-all;font-family:${MONO_STACK};font-size:11px;">${escapeHtml(signInUrl)}</span>
          </p>
        </td></tr>

        <!-- Footer note -->
        <tr><td style="padding:18px 32px 24px;border-top:1px solid ${PANEL_BORDER};">
          <p style="margin:0;color:${MUTED_2};font-size:11px;line-height:1.65;">
            Keep this key somewhere safe — it's your proof of access. Need help? Just reply to this email.
          </p>
        </td></tr>

      </table>

      <!-- Outside-card footer -->
      <p style="margin:18px 0 0;color:${MUTED_2};font-size:11px;line-height:1.6;text-align:center;font-family:${FONT_STACK};">
        © 2026 OverOwned LLC ·
        <a href="https://overowned.io/terms.html" style="color:${MUTED_2};text-decoration:underline;">Terms</a> ·
        <a href="https://overowned.io/privacy.html" style="color:${MUTED_2};text-decoration:underline;">Privacy</a> ·
        <a href="https://overowned.io/refund.html" style="color:${MUTED_2};text-decoration:underline;">Refund</a>
      </p>

    </td></tr>
  </table>
</body>
</html>`;
}

/* ── Plain-text fallback ────────────────────────────────────────────── */

function textBody({ key, signInUrl, tierBadge, headline, subhead, expirationLabel }) {
  return `OverOwned · ${tierBadge}
${'─'.repeat(40)}

${headline}

${subhead}

Your access key:

   ${key}

${expirationLabel}

Sign in:
${signInUrl}

Or visit https://app.overowned.io and paste your key.

Keep this key somewhere safe — it's your proof of access.
Need help? Just reply to this email.

— OverOwned
https://overowned.io
`;
}

/* ── Utilities ──────────────────────────────────────────────────────── */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}
