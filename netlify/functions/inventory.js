// netlify/functions/inventory.js
//
// Returns live inventory counts for Season 1 spots and Day Passes.
// Called from the landing page on load — public, no auth.
//
// Source of truth: public.license_stock (rows: tier='day' and tier='season').
// Falls back to the static defaults (25 / 50) on Supabase failure so a
// transient outage doesn't break the landing page render.

import { createClient } from '@supabase/supabase-js';

const SEASON_1_TOTAL = 25;
const DAY_PASS_TOTAL = 50;
const SEASON = '2026';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const handler = async () => {
  try {
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Supabase env vars not configured');
    }
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false }
    });

    // Pull both tier rows from license_stock in one query.
    const { data, error } = await supabase
      .from('license_stock')
      .select('tier, available, sold')
      .eq('season', SEASON)
      .in('tier', ['day', 'season']);
    if (error) throw error;

    const dayRow    = data?.find(r => r.tier === 'day')    ?? null;
    const seasonRow = data?.find(r => r.tier === 'season') ?? null;

    // Trust license_stock.available when set, fall back to compiled-in total.
    const dayTotal    = dayRow?.available    ?? DAY_PASS_TOTAL;
    const seasonTotal = seasonRow?.available ?? SEASON_1_TOTAL;
    const daySold     = dayRow?.sold    ?? 0;
    // Season sold = authoritative live count of issued season keys. The
    // hand-incremented license_stock.sold drifted (frozen since May), so we
    // count the real keys to self-heal the displayed spots-remaining.
    const { count: seasonKeyCount } = await supabase
      .from('license_keys')
      .select('*', { count: 'exact', head: true })
      .eq('plan', 'season').eq('status', 'active');
    const seasonSold  = Math.max(seasonKeyCount ?? 0, seasonRow?.sold ?? 0);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10, stale-while-revalidate=30'
      },
      body: JSON.stringify({
        season_remaining: Math.max(0, seasonTotal - seasonSold),
        season_total:     seasonTotal,
        daypass_remaining: Math.max(0, dayTotal - daySold),
        daypass_total:     dayTotal,
      }),
    };
  } catch (err) {
    console.error('[inventory] error', err);
    // Fail open — landing page has static fallback.
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'inventory_unavailable' }),
    };
  }
};
