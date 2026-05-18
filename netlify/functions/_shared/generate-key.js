// netlify/functions/_shared/generate-key.js
//
// Generates an OverOwned access key in the format:
//   OO-XXXX-XXXX-XXXX-XXXX
//
// 16 chars from a 32-char alphabet → 32^16 ≈ 1.2 × 10²⁴ possibilities,
// ~80 bits of entropy. Collisions are negligible at any realistic scale,
// but we still enforce UNIQUE on the database column for safety.
//
// Alphabet excludes ambiguous glyphs (0, O, 1, I, L) so keys are easy
// to read aloud / type if a user has to enter manually.

import { randomBytes } from 'crypto';

// 32 chars total. Length is a power of 2 so randomBytes can index without bias.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
// length 31 — close enough to 32 for unbiased modulo from a single byte.
// (256 % 31 = 8 → tiny bias; we mitigate by sampling fresh bytes per char.)

const PREFIX = 'OO';
const GROUP_COUNT = 4;
const CHARS_PER_GROUP = 4;
const TOTAL_CHARS = GROUP_COUNT * CHARS_PER_GROUP;

export function generateAccessKey() {
  // Pull more bytes than needed and skip any that fall into the modulo
  // bias region — guarantees a uniform distribution over the alphabet.
  const out = [];
  const max = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (out.length < TOTAL_CHARS) {
    const buf = randomBytes(TOTAL_CHARS * 2);
    for (let i = 0; i < buf.length && out.length < TOTAL_CHARS; i++) {
      if (buf[i] < max) out.push(ALPHABET[buf[i] % ALPHABET.length]);
    }
  }

  // Format as PREFIX-XXXX-XXXX-XXXX-XXXX
  let key = PREFIX;
  for (let g = 0; g < GROUP_COUNT; g++) {
    key += '-';
    key += out.slice(g * CHARS_PER_GROUP, (g + 1) * CHARS_PER_GROUP).join('');
  }
  return key;
}

// Strict format validator — useful for app-side `/sign-in?key=` parsing.
const KEY_RE = /^OO-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

export function isValidAccessKey(s) {
  return typeof s === 'string' && KEY_RE.test(s);
}
