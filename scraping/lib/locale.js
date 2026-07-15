// X's `lang:id` search operator was verified (empirically, against known-good 2025
// date ranges) to return zero results — it's unusable, not just narrow. Malaysian
// slang ("campak" = "to throw") otherwise dominates raw "campak" matches, so we
// filter client-side instead of relying on platform language operators.
//
// Two layers:
// 1. franc (statistical language ID) rejects anything outside the
//    Indonesian/Malay/regional-Austronesian language cluster — cheap and
//    reliable for gross-mismatch noise (Swahili, Japanese, English, Romanian,
//    etc. all showed up in real scraped X data and were being waved through by
//    the old "not obviously Malay -> assume Indonesian" fallback).
// 2. Within that cluster, franc itself is NOT reliable — verified empirically
//    that short, casual, genuinely-Indonesian text ("udahh kerenn cakep
//    keceeee...") gets the SAME "jav" (Javanese) code as actual Malay slang.
//    So Indonesian/Malay/Javanese/Sundanese/etc. all pass layer 1 and instead
//    get the colloquial-marker heuristic below, same as before.
//
// Indonesian and Malay are extremely close (mutually intelligible), sharing most
// vocabulary — "dengan", "ini", "itu", "kita", "saya", "anak", "campak", "vaksin"
// etc. exist in BOTH languages and do NOT discriminate between them (an earlier
// version of this filter used shared words like these and barely filtered anything
// out). Only genuinely colloquial-specific markers are useful here.
const { franc } = require('franc-min');

// ISO 639-3 codes for Indonesian, Malay variants, and the regional Austronesian
// languages spoken across Indonesia/Malaysia that franc tends to confuse casual
// Indonesian with. 'und' = undetermined (text too short/ambiguous) is also let
// through to the marker heuristic rather than rejected outright.
const AUSTRONESIAN_CLUSTER = new Set([
  'ind', 'zlm', 'zsm', 'msa', 'jav', 'sun', 'min', 'bug', 'ban', 'ace', 'mad', 'bjn', 'bbc', 'und',
]);

function passesLanguageFamilyCheck(text) {
  if (text.length < 15) return true; // franc is unreliable on very short strings; defer to markers
  const code = franc(text);
  return AUSTRONESIAN_CLUSTER.has(code);
}
// Note: no /g flag here — this one is used with .test(), and a global regex's
// lastIndex state would make repeated .test() calls on the same instance flaky.
const MALAYSIA_WORDS = /\b(kedah|selangor|perak|penang|pulau pinang|johor|melaka|malaysia|jkn_|mygov|kkmm|kkm|sarawak|sabah|terengganu|kelantan|pahang|labuan)\b/i;
const MALAY_ONLY_MARKERS = /\b(korang|kitorang|dorang|depa|hang|awak|mcm|giler|weyy|kau|tak|takyah|takde|takpe|xde|xleh|xnak|xtau|dkt|kt|kat|nak|nk|je|jer|sahaja|kene|bwh|lesen|amik|kereta|rasuah|tamadun|cikgu|longkang|siasat|disiasat)\b/gi;
// "nanti", "kenapa", "utk", "dgn" were dropped from this list — they're shared
// abbreviations/vocabulary used in both Indonesian and Malay, not discriminators.
const INDONESIAN_ONLY_MARKERS = /\b(gak|enggak|nggak|gue|gua|elo|banget|udah|emang|bikin|pake|gimana|gitu|nih|dong|sih|deh|kok|apaan|soalnya|kayak|ngerasa|ngerti|jadinya|beneran)\b/gi;

function isLikelyIndonesian(text) {
  if (!text) return false;
  if (!passesLanguageFamilyCheck(text)) return false;
  if (MALAYSIA_WORDS.test(text)) return false;

  const malayHits = (text.match(MALAY_ONLY_MARKERS) || []).length;
  const idHits = (text.match(INDONESIAN_ONLY_MARKERS) || []).length;

  if (malayHits > 0 && idHits === 0) return false;
  if (malayHits >= 2 && idHits < 2) return false;
  if (idHits > 0) return true;

  // No colloquial markers either way (e.g. formal/news-style text, which reads
  // identically in Indonesian and Malay) — treat as plausibly Indonesian, since
  // rejecting it outright would lose legitimate formal-register content, and the
  // downstream semantic classifier is the real precision layer.
  return malayHits === 0;
}

module.exports = { isLikelyIndonesian };
