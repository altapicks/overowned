// netlify/functions/inventory.js
//
// Returns live inventory counts for Season 1 spots and Day Passes.
// Called from the landing page on load — public, no auth.
//
// Counts come from Supabase. Failures fall through to the static defaults
// the landing page hardcoded (25 / 50), so a Supabase outage doesn't prevent
// the page from rendering — visitors just see "25 of 25" until it recovers.

import { createClient } from '@supabase/supabase-js';

const SEASON_1_TOTAL = 25;
const DAY_PASS_TOTAL = 50;

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

    // Count active Season 1 passes and active Day Passes (any status that
    // counts toward inventory: paid, granted, etc — anything that has used
    // up a seat).
    const [seasonRes, dayPassRes] = await Promise.all([
      supabase
        .from('season_passes')
        .select('id', { count: 'exact', head: true })
        .eq('season', 1)
        .in('status', ['active', 'pending']),
      supabase
        .from('day_passes')
        .select('id', { count: 'exact', head: true })
        .eq('season', 1)
    ]);

    const seasonUsed = seasonRes.count ?? 0;
    const dayPassUsed = dayPassRes.count ?? 0;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10, stale-while-revalidate=30'
      },
      body: JSON.stringify({
        season_remaining: Math.max(0, SEASON_1_TOTAL - seasonUsed),
        season_total: SEASON_1_TOTAL,
        daypass_remaining: Math.max(0, DAY_PASS_TOTAL - dayPassUsed),
        daypass_total: DAY_PASS_TOTAL,
      }),
    };
  } catch (err) {
    console.error('inventory error', err);
    // Fail open — landing page has static fallback.
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'inventory_unavailable' }),
    };
  }
};
