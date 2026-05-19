// netlify/functions/_shared/render-key-email.js
//
// OverOwned access-key email — uses the live marketing-site design
// tokens (not hardcoded approximations). Tokens sourced from
// overowned-main/index.html :root and resolved to inline hex/rgba
// for email-client safety (Gmail/Outlook/Apple Mail strip CSS vars).
//
// Source → resolved mapping (single source of truth — index.html
// :root). When tokens change there, mirror them here:
//
//   --oo-bg            #06111f
//   --oo-panel-flat    #0d1d30     (opaque panel — email-safe)
//   --oo-border        rgba(138,170,210,0.16)
//   --oo-text          #f6f8fc
//   --oo-muted         #8ea0bb
//   --oo-muted-2       #60718c
//   --oo-gold          #ffd11a     (brand gold)
//   --oo-gold-soft     rgba(255,209,26,0.14)
//   --oo-gold-ring     rgba(255,209,26,0.32)
//   --oo-radius-sm     10px        (.btn radius)
//   --oo-radius-md     14px        (key data-cell)
//   --oo-radius-lg     20px        (card)
//   --oo-shadow        0 18px 50px rgba(0,0,0,0.35)
//   --oo-glow-gold-sm  0 0 18px rgba(255,209,26,0.25)
//   --oo-font          'Inter', -apple-system, …
//   --oo-mono          'JetBrains Mono', ui-monospace, …
//
// Button mirrors .btn--primary exactly: padding 13px 26px, radius
// var(--oo-radius-sm), bg var(--oo-gold), color var(--oo-bg),
// shadow 0 6px 22px rgba(255,209,26,0.28).

// ─── Design tokens (resolved from :root) ─────────────────────────
const T = {
  bg:          '#06111f',
  panel:       '#0d1d30',
  border:      'rgba(138, 170, 210, 0.16)',
  text:        '#f6f8fc',
  muted:       '#8ea0bb',
  muted2:      '#60718c',
  gold:        '#ffd11a',
  goldSoft:    'rgba(255, 209, 26, 0.14)',
  goldRing:    'rgba(255, 209, 26, 0.32)',
  radiusSm:    '10px',  // buttons
  radiusMd:    '14px',  // data cell
  radiusLg:    '20px',  // card
  shadow:      '0 18px 50px rgba(0, 0, 0, 0.35)',
  glowGoldSm:  '0 0 18px rgba(255, 209, 26, 0.25)',
  font:        `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`,
  mono:        `'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace`,
};

/**
 * Render the OverOwned access key email.
 *
 * @param {object} opts
 * @param {string} opts.key         - "OO-A4F2-9X3K-B7M1-Q8R5"
 * @param {string} opts.signInUrl   - sign-in URL with ?key=...
 * @param {string} opts.tier        - 'season-1' | 'day-pass'
 * @param {Date|string} [opts.expiresAt] - access expiration
 */
export function renderKeyEmail({ key, signInUrl, tier, expiresAt }) {
  const isSeasonPass = tier === 'season-1';

  const subject  = isSeasonPass
    ? 'Your OverOwned Season 1 access key'
    : 'Your OverOwned day pass key';

  const tierBadge = isSeasonPass ? 'SEASON 1' : 'DAY PASS';

  // Key-centric copy (Alta 2026-05-18): the key is the hero, copy
  // points the reader at activating it — not at signing in.
  let expirationLine;
  let subhead;
  if (isSeasonPass) {
    const d = expiresAt instanceof Date ? expiresAt : new Date(expiresAt ?? '2026-07-12T23:59:59-04:00');
    const formatted = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    expirationLine = `Expires ${formatted}`;
    subhead = `Use this access key to unlock OverOwned through ${formatted}.`;
  } else {
    expirationLine = '24-hour access · activates on first use';
    subhead = 'Use this access key to unlock 24 hours of OverOwned.';
  }

  return {
    subject,
    html: htmlBody({ key, signInUrl, tierBadge, expirationLine, subhead }),
    text: textBody({ key, signInUrl, tierBadge, expirationLine, subhead }),
  };
}

/* ── HTML template ──────────────────────────────────────────────────── */

function htmlBody({ key, signInUrl, tierBadge, expirationLine, subhead }) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Your OverOwned access key</title>
  <style>
    /* Mobile (Apple Mail, Gmail iOS, modern clients). Outlook ignores
       gracefully — desktop layout already works there. */
    @media only screen and (max-width: 600px) {
      .oo-card  { width: 100% !important; max-width: 100% !important; border-radius: 0 !important; }
      .oo-pad-x { padding-left: 16px !important; padding-right: 16px !important; }
      .oo-key   { font-size: 16px !important; letter-spacing: 1.5px !important; }
      .oo-cta a { display: block !important; padding-left: 16px !important; padding-right: 16px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${T.bg};font-family:${T.font};-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;">

  <!-- Preheader (hidden inbox preview) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;color:${T.bg};opacity:0;">
    ${escapeHtml(key)} — ${escapeHtml(expirationLine)}
  </div>

  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${T.bg};padding:48px 16px;">
    <tr><td align="center">

      <!-- Card: panel-flat bg, 1px border, radius-md (14px) per spec
           ("12-16px"). No heavy shadow per spec — the border + tint
           on the key cell carry the visual weight. -->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="520" class="oo-card" style="max-width:520px;background:${T.panel};border:1px solid ${T.border};border-radius:${T.radiusMd};">

        <!-- Header row: logo + brand left + tier pill right.
             Logo is hosted from overowned.io and inlined here. Width
             is set on both the img + the table cell so Outlook scales
             it consistently. -->
        <tr><td class="oo-pad-x" style="padding:32px 32px 0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td align="left" valign="middle">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td valign="middle" style="padding-right:10px;width:32px;">
                      <img src="https://overowned.io/apple-touch-icon.png"
                           alt="OverOwned"
                           width="32" height="32"
                           style="display:block;width:32px;height:32px;border-radius:8px;border:1px solid ${T.goldRing};" />
                    </td>
                    <td valign="middle" style="font-size:18px;font-weight:800;color:${T.text};letter-spacing:-0.3px;line-height:1;font-family:${T.font};">
                      Over<span style="color:${T.gold};">O</span>wned
                    </td>
                  </tr>
                </table>
              </td>
              <td align="right" valign="middle">
                <!-- Tier pill — mirrors SLAM/500/250 badge style -->
                <span style="display:inline-block;padding:5px 12px;background:transparent;color:${T.gold};font-size:10px;font-weight:700;letter-spacing:1.8px;border:1px solid ${T.goldRing};border-radius:999px;font-family:${T.font};">
                  ${escapeHtml(tierBadge)}
                </span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Subhead — key-centric copy, key as the hero -->
        <tr><td class="oo-pad-x" style="padding:32px 32px 24px;">
          <p style="margin:0;color:${T.text};font-size:15px;line-height:1.5;font-family:${T.font};font-weight:500;">
            ${escapeHtml(subhead)}
          </p>
        </td></tr>

        <!-- Eyebrow above key cell -->
        <tr><td class="oo-pad-x" style="padding:0 32px 12px;">
          <div style="font-size:10px;font-weight:700;color:${T.muted2};letter-spacing:1.8px;text-transform:uppercase;line-height:1;">
            Your Access Key
          </div>
        </td></tr>

        <!-- Key data cell — full-width, gold-tinted, radius-md, 24px pad -->
        <tr><td class="oo-pad-x" style="padding:0 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr><td style="background:${T.goldSoft};border:1px solid ${T.goldRing};border-radius:${T.radiusMd};padding:24px 16px;text-align:center;">
              <span class="oo-key" style="font-family:${T.mono};font-size:21px;font-weight:700;color:${T.gold};letter-spacing:3px;user-select:all;-webkit-user-select:all;">${escapeHtml(key)}</span>
            </td></tr>
          </table>
        </td></tr>

        <!-- Expiration — small muted label, 8px gap -->
        <tr><td class="oo-pad-x" style="padding:8px 32px 0;text-align:center;">
          <div style="font-size:12px;color:${T.muted};letter-spacing:0.1px;line-height:1.4;">
            ${escapeHtml(expirationLine)}
          </div>
        </td></tr>

        <!-- CTA — exact mirror of .btn--primary -->
        <tr><td class="oo-pad-x oo-cta" align="center" style="padding:32px 32px 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="background:${T.gold};border-radius:${T.radiusSm};box-shadow:0 6px 22px rgba(255, 209, 26, 0.28);">
              <a href="${escapeAttr(signInUrl)}"
                 style="display:inline-block;padding:13px 26px;color:${T.bg};text-decoration:none;font-size:14px;font-weight:700;letter-spacing:0.1px;font-family:${T.font};border-radius:${T.radiusSm};">
                Activate your key
              </a>
            </td></tr>
          </table>
        </td></tr>

        <!-- Divider + tiny muted footer -->
        <tr><td class="oo-pad-x" style="padding:32px 32px 32px;">
          <div style="height:1px;background:${T.border};margin-bottom:16px;line-height:1px;font-size:0;">&nbsp;</div>
          <p style="margin:0;color:${T.muted2};font-size:11px;line-height:1.6;text-align:center;font-family:${T.font};">
            Need help? Just reply to this email.
          </p>
        </td></tr>

      </table>

      <!-- Outside-card legal footer -->
      <p style="margin:16px 0 0;color:${T.muted2};font-size:11px;line-height:1.6;text-align:center;font-family:${T.font};">
        © 2026 OverOwned LLC ·
        <a href="https://overowned.io/terms.html" style="color:${T.muted2};text-decoration:underline;">Terms</a> ·
        <a href="https://overowned.io/privacy.html" style="color:${T.muted2};text-decoration:underline;">Privacy</a> ·
        <a href="https://overowned.io/refund.html" style="color:${T.muted2};text-decoration:underline;">Refund</a>
      </p>

    </td></tr>
  </table>
</body>
</html>`;
}

/* ── Plain-text fallback ────────────────────────────────────────────── */

function textBody({ key, signInUrl, tierBadge, expirationLine, subhead }) {
  return `OverOwned · ${tierBadge}

${subhead}

Your access key:

  ${key}

${expirationLine}

Activate: ${signInUrl}

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
