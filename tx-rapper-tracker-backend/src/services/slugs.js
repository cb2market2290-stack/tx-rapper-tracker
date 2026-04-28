// src/services/slugs.js
// Phase 3c — slug derivation for public artist URLs.
//
// Pure helpers (slugify + reverse lookup) that drive the /a/:slug
// route + the migration 016 backfill. The slugify rules are LOCKED
// AT V1 in PHASE_3C_DESIGN.md — anyone who shares a public URL
// expects it to keep working, so changing the rules silently would
// break every shared link.
//
// What "v1" means concretely:
//   1. NFKD-fold (decompose precomposed accented chars into base + combining mark).
//   2. Strip combining marks (= ASCII-fold for Latin diacritics).
//   3. Lowercase.
//   4. Replace '&' with ' and ' (so "Chloe & Halle" reads naturally as
//      "chloe-and-halle" not "chloe-halle" which loses meaning).
//   5. Drop everything outside [a-z 0-9 whitespace -].
//   6. Collapse whitespace runs to a single hyphen.
//   7. Collapse hyphen runs.
//   8. Trim leading/trailing hyphens.
//
// Step 5 deliberately drops underscores (rare in artist names; if one
// appears we'd want it visually represented as a hyphen, not preserved).
// This matches what migration 016's Postgres-side backfill does.

import { query } from '../db/pool.js';

/**
 * Convert an artist's display name to its URL-safe slug.
 *
 * Pure. No I/O. Stable across Node versions because we only use
 * String.prototype methods that are part of ECMAScript proper.
 *
 * @param {string} name
 * @returns {string}
 */
export function slugify(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // strip combining diacritical marks
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, '')      // drop everything else (incl. underscores)
    .trim()
    .replace(/\s+/g, '-')              // whitespace → single hyphen
    .replace(/-+/g, '-')               // collapse hyphen runs
    .replace(/^-|-$/g, '');            // trim leading/trailing hyphens
}

// UUID validator — used by the few public-route paths that accept an
// id alongside a slug.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Slug shape — alphanumeric + hyphens, 1-100 chars, must start with
// alphanumeric. The route uses this as a cheap reject-bad-input
// before hitting the DB.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function isValidSlug(s) {
  return typeof s === 'string' && SLUG_RE.test(s);
}

// ---------------------------------------------------------------------------
// DB-touching path
// ---------------------------------------------------------------------------

/**
 * Look up an artist by slug for the public profile route.
 *
 * Filters on is_public AND NOT is_archived — both gates apply. Admin
 * sets is_public=false to hide an individual artist from the public
 * surface; is_archived=true is the existing soft-delete. Either one
 * → 404 from the public route's perspective.
 *
 * Returns null on miss. Returns the full row shape (id, name, slug,
 * sort_order, is_public) on hit.
 */
export async function getPublicArtistBySlug(slug) {
  if (!isValidSlug(slug)) return null;
  const { rows } = await query(
    `SELECT id, name, slug, sort_order, is_public
       FROM artists
      WHERE slug = $1
        AND is_public = TRUE
        AND NOT is_archived
      LIMIT 1`,
    [slug]
  );
  return rows[0] || null;
}

/**
 * Resolve a list of slugs to artist rows for the /compare/:slugs route.
 *
 * Silently drops unknown / private / archived slugs (same posture as
 * the in-app compare which renders 0 cards for an unknown name rather
 * than 404'ing the whole view). Order is preserved exactly as the
 * input array specifies — useful when someone builds a URL with a
 * specific left-to-right ordering for screenshots.
 *
 * @param {string[]} slugs
 * @returns {Promise<Array>}  artist rows in the input order
 */
export async function getPublicArtistsBySlugs(slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) return [];
  const valid = slugs.filter(isValidSlug);
  if (valid.length === 0) return [];
  const { rows } = await query(
    `SELECT id, name, slug, sort_order, is_public
       FROM artists
      WHERE slug = ANY($1::text[])
        AND is_public = TRUE
        AND NOT is_archived`,
    [valid]
  );
  // Preserve the input order. Build a Map from slug → row for an O(N) sort.
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  return valid.map((s) => bySlug.get(s)).filter(Boolean);
}

/**
 * List every artist that should appear in /sitemap.xml.
 *
 * Plain array of { slug, name } — order by slug for deterministic
 * sitemap output (sitemap diffs across deploys are easier to read
 * when the order is stable).
 */
export async function getPublicArtistRoster() {
  const { rows } = await query(
    `SELECT slug, name
       FROM artists
      WHERE is_public = TRUE
        AND NOT is_archived
      ORDER BY slug ASC`
  );
  return rows;
}

// Re-export for tests / route validation.
export { UUID_RE };
