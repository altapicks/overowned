# Key system — what was wired and what you need to do

## Summary

The marketing site's Netlify Functions (`claim-day-pass.js`, `stripe-webhook.js`, `inventory.js`) now read and write from your existing **`license_keys`** / **`license_stock`** tables in the `OverOwned Paywall` Supabase project. The legacy `day_passes` / `season_passes` tables are no longer being written to (per your decision — they remain in the schema if you want to archive or migrate historical data later).

The supabase magic-link flow is **removed**. Users now receive an access key in their email and authenticate against the app at `app.overowned.io/sign-in?key=OO-XXXX-XXXX-XXXX-XXXX`.

## What's in this folder

- `generate-key.js` — generates `OO-XXXX-XXXX-XXXX-XXXX` keys using `crypto.randomBytes` with an unambiguous-glyph alphabet (no 0/O/1/I/L confusion). Matches the format of your existing `license_keys.key` column.
- `render-key-email.js` — one shared, parameterized email template (Day Pass vs Season 1). Dark-navy + gold-accent design that matches the home tab visual language. Returns `{ subject, html, text }`.

## What you need to do — one-time setup

### 1. Run this SQL in Supabase (OverOwned Paywall project)

```sql
-- 1a. Set day-tier stock to 50 to match the marketing page's "50 of 50 trials" copy.
UPDATE public.license_stock
   SET available = 50,
       updated_at = now()
 WHERE tier = 'day'
   AND season = '2026';

-- 1b. Index license_keys for the dedup lookups Netlify Functions do.
CREATE INDEX IF NOT EXISTS idx_license_keys_email_plan_status
    ON public.license_keys (email, plan, status);

-- 1c. CRITICAL — replace the active_access view to read from licenses
-- (the new system) plus surface lifetime keys (which live only in
-- license_keys, not licenses). Without this, the new email flow creates
-- keys but the app's access check returns false for those users — and
-- pre-existing lifetime keys silently lose access after the migration.
CREATE OR REPLACE VIEW public.active_access AS
-- Day + Season passes (sourced from licenses)
SELECT user_id, tier AS kind, expires_at, status
  FROM public.licenses
 WHERE status = 'active'
   AND expires_at > now()
   AND user_id IS NOT NULL
UNION ALL
-- Lifetime keys (sourced from license_keys, joined to auth.users by email)
SELECT u.id AS user_id, 'season'::text AS kind, NULL::timestamptz AS expires_at, k.status
  FROM public.license_keys k
  JOIN auth.users u ON lower(u.email) = lower(k.email)
 WHERE k.status = 'active'
   AND k.plan = 'lifetime'
   AND k.expires_at IS NULL;
```

**Note**: lifetime keys appear as `kind='season'` in `active_access` so the app's access checks (which expect `'season'` for everything-included tiers) treat them identically. Your own lifetime key (`OO-A7XK-B2P9-N4M1-Q8RX`) will surface here as long as `altapicks@gmail.com` exists in `auth.users` — verify after running the migration with: `SELECT * FROM public.active_access WHERE user_id = (SELECT id FROM auth.users WHERE lower(email) = 'altapicks@gmail.com');`

### 2. (Optional but recommended) Add a `stripe_session_id` column to license_keys

This gives you proper Stripe-event-level idempotency on the webhook so a re-delivered `checkout.session.completed` can never grant a duplicate key:

```sql
ALTER TABLE public.license_keys
  ADD COLUMN IF NOT EXISTS stripe_session_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_license_keys_stripe_session_id
    ON public.license_keys (stripe_session_id)
 WHERE stripe_session_id IS NOT NULL;
```

If you add this, also update `stripe-webhook.js`:

```js
// Replace the existing email-based dedup with this:
const { data: existingKey } = await supabase
  .from('license_keys')
  .select('key')
  .eq('stripe_session_id', session.id)
  .maybeSingle();
if (existingKey) {
  console.log(`Idempotent skip — session ${session.id} already processed`);
  return;
}

// And on the insert, add the column:
.insert({
  key: accessKey,
  plan: PLAN,
  status: 'active',
  email,
  expires_at: SEASON_EXPIRES_AT,
  stripe_session_id: session.id,    // ← new
})
```

The current code uses email-based dedup as a fallback — works fine, but session-id is the airtight version.

### 3. App-side: build the `/sign-in?key=` handler on `app.overowned.io`

Your Next.js app needs a route that:

1. Reads `?key=` from the URL.
2. Validates the key format (use `isValidAccessKey` from `generate-key.js` if you copy the helper across).
3. Looks up the key in `public.license_keys`:
   - `status = 'active'`
   - `expires_at > now()` (or `expires_at IS NULL` for lifetime keys)
4. If valid, mint a Supabase session for the email on the key:
   - Either via `supabase.auth.admin.createUser` (if no user yet) + `generateLink('magiclink')` server-redirect,
   - Or via a server-side helper that issues a session JWT directly using the service-role key.
5. Insert a row into `license_sessions` (you have this table — I didn't inspect its schema; if it tracks { license_key, user_id, ip, ua, started_at } that's the standard shape).
6. Redirect to `/dashboard` or wherever the home tab lives.

Example skeleton (`app/sign-in/route.ts` — Next.js App Router):

```ts
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const KEY_RE = /^OO-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!key || !KEY_RE.test(key)) {
    return NextResponse.redirect(new URL('/sign-in?error=invalid_key', url));
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: row } = await supabase
    .from('license_keys')
    .select('key, plan, status, email, expires_at')
    .eq('key', key)
    .maybeSingle();

  if (!row || row.status !== 'active') {
    return NextResponse.redirect(new URL('/sign-in?error=invalid_or_revoked', url));
  }
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return NextResponse.redirect(new URL('/sign-in?error=expired', url));
  }

  // Mint a magic-link redirect for the email so Supabase auth state is set
  const { data: linkData } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: row.email,
    options: { redirectTo: new URL('/', url).toString() },
  });
  if (!linkData?.properties?.action_link) {
    return NextResponse.redirect(new URL('/sign-in?error=auth_failed', url));
  }

  // Optionally: record the session
  await supabase.from('license_sessions').insert({
    license_key: row.key,
    started_at: new Date().toISOString(),
  });

  return NextResponse.redirect(linkData.properties.action_link);
}
```

(If `license_sessions` uses different column names, adjust the insert above.)

You also probably want a manual key-entry page at `/sign-in` so users who copy/paste the key from the email (instead of clicking the link) can authenticate.

## What changed in the marketing site Netlify Functions

| File | Before | After |
|---|---|---|
| `claim-day-pass.js` | Wrote to `day_passes`, generated Supabase magic link | Generates a key, writes to `license_keys`, increments `license_stock.day.sold`, emails the key |
| `stripe-webhook.js` | Wrote to `season_passes`, generated Supabase magic link | Generates a key, writes to `license_keys`, increments `license_stock.season.sold`, emails the key. Refund handler updates `license_keys.status='refunded'` |
| `inventory.js` | Counted rows in `season_passes` / `day_passes` | Reads `available - sold` from `license_stock` for `tier='day'` and `tier='season'` |
| `_shared/generate-key.js` | NEW | Crypto-random OO-XXXX-XXXX-XXXX-XXXX generator |
| `_shared/render-key-email.js` | NEW | Shared email template, parameterized for both tiers |

## What env vars you need (no new ones)

All existing vars on the marketing site Netlify project are still required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`

The app project (`overownedap`) doesn't need any new vars for the `/sign-in?key=` handler — it already has `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Smoke test before announcing

1. Run the SQL migration above.
2. Deploy the marketing site (push to git → Netlify rebuilds).
3. Submit a real email through the Day Pass form on overowned.io.
4. Check Resend → Emails — should see a "Your OverOwned 24-hour Day Pass" delivery with the new key-style template.
5. Check Supabase Table Editor → `license_keys` — new row with your key.
6. Check Supabase Table Editor → `license_stock` — `tier='day'` row's `sold` should be `1`.
7. Once the app-side `/sign-in?key=` handler is built, click the link from the email and confirm you land authenticated.
