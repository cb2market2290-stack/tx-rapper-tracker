-- migrations/016_artist_slugs.sql
-- Phase 3c.2 — public artist profile pages (/a/:slug) need a stable
-- URL identifier per artist + an admin-flippable visibility flag so
-- individual artists can be hidden from the public surface without
-- being archived from the in-app roster.
--
-- Two new columns on `artists`:
--
--   * slug    TEXT UNIQUE — kebab-case derived from name. Permanent
--     once published; the slug-derivation rules are LOCKED at v1
--     in PHASE_3C_DESIGN.md because anyone who shares a public URL
--     expects it to keep working. Bumping the rules silently
--     would break every shared link.
--
--   * is_public BOOLEAN — default TRUE (roster is small + curated;
--     opt-in is the right default per PHASE_3_BRAINSTORM.md open
--     question 3). Admin flips to FALSE to hide an individual
--     artist from /a/:slug without archiving them from the in-app
--     dashboard. The signed-in roster surface ignores this flag —
--     only the public route gates on it.
--
-- Backfill strategy:
--   1. Add the columns NULLable so existing rows remain valid mid-migration.
--   2. Compute slug for every existing row using a Postgres-side
--      slugify function that mirrors the JS implementation in
--      services/slugs.js (NFKD-fold approximation via translate +
--      lower + regex replace). Postgres doesn't have a true NFKD
--      surface in stdlib; we cover the diacritics that show up on
--      the actual roster (é, ö, à, etc.) via translate(). The JS
--      side handles the full NFKD; the SQL side covers what's in
--      the seed list.
--   3. Set NOT NULL + UNIQUE.
--   4. Set is_public DEFAULT TRUE + NOT NULL.
--
-- If two existing rows happen to slugify to the same value, the
-- UNIQUE constraint blows the migration up loudly — exactly what
-- we want. Fail closed; admin disambiguates by editing one of the
-- names.

BEGIN;

-- Step 1: nullable columns
ALTER TABLE artists ADD COLUMN IF NOT EXISTS slug TEXT;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS is_public BOOLEAN;

-- Step 2: backfill slugs for existing rows. Postgres-side slugify
-- mirrors services/slugs.js for the cases on the actual roster:
-- ASCII-fold via translate(), lower(), '&' → ' and ', drop quotes/
-- parens/dots via regexp_replace, whitespace → hyphen, collapse
-- runs, trim.
UPDATE artists
SET slug = trim(both '-' FROM
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            lower(
              translate(
                name,
                'àáâãäåāăąçćčďèéêëēĕėęěíìîïīĭįıłñňòóôõöōŏőřśšßťùúûüūŭůűýÿžź',
                'aaaaaaaaacccdeeeeeeeeeiiiiiiiilnnoooooooorsssstuuuuuuuuyyzz'
              )
            ),
            '&', ' and ', 'g'
          ),
          '[^[:alnum:][:space:]-]', '', 'g'
        ),
        '\s+', '-', 'g'
      ),
      '-+', '-', 'g'
    )
  )
WHERE slug IS NULL;

-- Step 3: any leftover empty-string slugs (an all-symbol name? unlikely
-- but defensive) become the artist UUID's first 8 chars so the UNIQUE
-- constraint can pass. Loud-failure-via-uniqueness is still the desired
-- outcome on actual collision; this only covers degenerate empty cases.
UPDATE artists
SET slug = substr(id::text, 1, 8)
WHERE slug = '' OR slug IS NULL;

-- Step 4: lock down
ALTER TABLE artists
  ALTER COLUMN slug SET NOT NULL,
  ADD CONSTRAINT artists_slug_unique UNIQUE (slug);

ALTER TABLE artists
  ALTER COLUMN is_public SET DEFAULT TRUE;

UPDATE artists SET is_public = TRUE WHERE is_public IS NULL;

ALTER TABLE artists
  ALTER COLUMN is_public SET NOT NULL;

-- Slug lookups are the hot path on the public route; one btree on
-- the unique slug column. Postgres auto-creates a unique index for
-- the constraint so we don't add a second one explicitly.

-- Public-list queries (sitemap.xml, /robots.txt) want
-- WHERE is_public AND NOT is_archived ORDER BY slug. Partial index.
CREATE INDEX IF NOT EXISTS artists_public_slug_idx
  ON artists (slug)
  WHERE is_public AND NOT is_archived;

COMMENT ON COLUMN artists.slug IS
  'URL-safe identifier for /a/:slug + /compare/:slugs. Derived from name via services/slugs.js#slugify (locked at v1 in PHASE_3C_DESIGN.md).';

COMMENT ON COLUMN artists.is_public IS
  'Whether the artist appears at /a/:slug. Default TRUE. FALSE hides from public route + sitemap but keeps the row visible to signed-in users.';

COMMIT;
