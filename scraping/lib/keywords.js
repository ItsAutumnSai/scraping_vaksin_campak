/**
 * Candidate-retrieval keywords. These cast a WIDE net on purpose — the semantic
 * classifier (classify/classify_relevance.py) does the real relevance filtering
 * afterward. Deliberately trimmed vs. openclaw_workspace/instagram_full_scraper.js's
 * ~120-term list: that list included fully generic parenting/nutrition terms
 * (anak, ASI, MPASI, stunting, ibudananak, ...) which would burn the per-platform
 * row cap on content that has nothing to do with vaccination at all. Kept to
 * measles/rubella/MR- and immunization-specific terms.
 */

// Used for search-query platforms (X, Facebook) — combined into OR-queries.
const CORE_KEYWORDS = [
  'campak',
  'vaksin campak',
  'vaksin MR',
  'vaksin rubella',
  'imunisasi campak',
  'campak rubella',
  'anti vaksin',
  'efek samping vaksin',
  'imunisasi anak',
  'vaksinasi anak',
  'KIPI',
  'PIN campak',
  'wabah campak',
  'kasus campak',
  'rubella',
];

// Used for hashtag/tag-page platforms (Instagram, Threads) — one lookup per tag.
const HASHTAG_KEYWORDS = [
  'campak',
  'vaksincampak',
  'vaksinmr',
  'vaksinrubella',
  'imunisasicampak',
  'campakrubella',
  'antivaksin',
  'efeksampingvaksin',
  'imunisasianak',
  'vaksinasianak',
  'kipi',
  'pincampak',
  'imunisasidasar',
  'imunisasilengkap',
  'imunisasirutin',
  'imunisasikejar',
  'kejarimunisasi',
  'imunisasinasional',
  'vaksinasinasional',
  'imunisasibayi',
  'vaksinbayi',
  'imunisasibalita',
  'vaksinbalita',
  'bulanimunisasi',
  'bias',
  'cakupanimunisasi',
  'idl',
  'measles',
  'rubella',
  'mmr',
  'wabahcampak',
  'kasuscampak',
];

module.exports = { CORE_KEYWORDS, HASHTAG_KEYWORDS };
