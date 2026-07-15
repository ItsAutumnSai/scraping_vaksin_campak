# Scraping + classification progress status

Last updated: 2026-07-15

## How to read this file
- ✅ = done and verified correct
- Row/account counts below are snapshots — check `wc -l scraping/out/*.csv` or `pd.read_csv(...).shape` for current counts (note: `wc -l` overcounts on files with embedded newlines in quoted text, e.g. Threads — trust pandas' row count instead).
- Everything below is considered **done**. No scraping or comment-fetching is planned to continue — per your instruction, data collection is frozen; only correctness fixes (counts, views, classification) have continued since.

## Classification — the key deliverable

`classify/classify_relevance.py` scores each row for relevance using:
1. **Hard language gate** (`is_strictly_indonesian`) — Indonesian only, no English/Japanese/Malay. Three-layer: a non-Latin-script hard reject (CJK/Kana/Hangul/Arabic/Cyrillic/Thai — catches short foreign text that used to slip past the length-gated langid check), `py3langid` for gross rejection, and curated word-marker lists for the Indonesian-vs-Malay distinction (langid alone isn't reliable there). The Malay-marker list and the Malaysia-specific hard-reject list (`MALAYSIA_WORDS_RE`) both went through a real bug-fix round after you flagged Malaysian content passing through on X — found word-boundary failures on hashtag/mention-glued terms (`#malaysiagazette`, `@KKMPutrajaya`), missing signals (`bernama.com`, `MySejahtera`, `Putrajaya`, `kesihatan`), and missing Malay-only vocabulary (`wabak`/wabah, `tempah`/pesan, `ubat`/obat, `pesakit`/pasien, `kanak-kanak`/anak-anak, `menghidap`/mengidap, `pramatang`/prematur). Verified 0 remaining Malaysian leakage across all 4 platforms after the fix.
2. **Hard topical gate** (`has_topic_keyword`) — replaced an earlier pure-embedding-similarity approach that proved too unreliable (generic Indonesian health content scored above any workable threshold just from vocabulary overlap, with zero connection to measles). Now requires either:
   - an explicit campak/rubella/measles/MR mention (checked on the reply's own text *or* its parent post's text, so a contentless reply like "iya aku setuju" on an on-topic post still counts), or
   - a generic "vaksin"/"imunisasi" mention with no other specific vaccine named (COVID, HPV, flu, animal vaccines, RSV, etc. — see `OTHER_SPECIFIC_VACCINE_RE`) and not an advertisement (see `AD_VETO_RE` — clinic/business ads that just list "imunisasi" as one of several services don't count).
3. **Veto patterns** for literal "campak" used as Malay/Indonesian slang for throw/discard (`dicampakkan`, `campak ke <anywhere>`, `campak <object>`) — some are hard vetoes (unambiguous, e.g. "campak bayi") that apply regardless of score; others are soft (only apply if the model's own confidence is low), since wordplay can appear inside genuinely on-topic posts.
4. **Topic score floor** — even a literal keyword match is downgraded to borderline if the embedding score is clearly negative (catches incidental mentions, e.g. a movie synopsis noting a character "nyaris tewas karena sakit campak").

Output columns per row: `relevance_score`, `veto_reason`, `is_indonesian`, `has_topic_keyword`, `is_relevant`, `borderline`. Filter on `is_relevant == True` for the clean subset; `borderline == True` rows are flagged for optional manual review (ambiguous veto cases, low-confidence keyword matches, or high-scoring non-keyword matches) — not silently dropped, not auto-included.

**This went through several rounds of real bug fixes** after you spot-checked specific rows (index 118/164/173/203 on Facebook, and manual review of X/Instagram samples) — see git history / conversation for the full list. Known residual limitations:
- Facebook: 59 rows still truncated ("Lihat selengkapnya") with no link at all to resolve from — unfixable. Another ~85 have a link but the canonical post/caption wasn't discoverable (deleted, restricted, or genuinely not linkable).
- No keyword/veto system is perfect — the `borderline` bucket exists specifically so you can catch what regex-based rules miss.

## Per-platform final state

### X (`out/x_vaccine_2024_2026.csv`) — 2227 rows
- ✅ View-count bug fully fixed (3 separate bugs found: `parseInt` truncation on "27.7K", only checking the first article on a permalink page, and analytics text being "27.7K Views" not "27.7K"). 2226/2227 rows now have a resolved view count; verified exact match against your example (Melati_Hani tweet: 27700).
- ✅ Comments fetched: 974 tweets visited, 1253 replies added.
- ✅ Classified: **1218 relevant / 616 borderline / 2227 total** (post language-gate fix).

### Threads (`out/threads_vaccine_2024_2026.csv`) — 15892 rows
- ✅ Counts bug fixed (label-anchored extraction replacing positional guessing); re-applied to all 1735 original posts — 1733 fixed (99.9%), verified exact match against your example (row 6: 616/161/209/163).
- ✅ Comment-fetching stopped per your instruction ("they're already enough") — 15892 rows preserved, verified not corrupted.
- ✅ Classified: **2921 relevant / 2354 borderline / 15892 total** (post language-gate fix).

### Instagram (`out/instagram_vaccine_2024_2026.csv`) — 228 rows
- ✅ Marked done per your instruction — 227 hashtag-scraped rows + partial influencer scrape (14/50 accounts before rate-limited; not resumed, no further scraping planned).
- ✅ Classified: **7 relevant / 94 borderline / 228 total**. Low relevant count reflects real data composition — this dataset is mostly clinic/business advertisements with only incidental "vaksin"/"imunisasi" mentions, as you noted early on.

### Facebook (`out/facebook_vaccine_2024_2026.csv`) — 2405 rows
- ✅ Main scrape, text-truncation fix, comments (1952 added), and engagement counts all complete and verified against your row-9 example.
- ✅ Targeted retry on truncated rows found a real bug (reel captions use a different DOM structure + emoji-prefix mismatch broke exact-prefix matching) — fixed, resolved 15 more rows.
- ✅ Classified: **1397 relevant / 197 borderline / 2405 total** (post language-gate fix).

## What's NOT done (by design, per your instructions)
- No merging across platforms — you're doing that yourself.
- No further data collection on any platform.
- The 59+85 unresolved-truncation Facebook rows — flagged, not silently fixed further (diminishing returns on retry).

## Files
- `scraping/out/*.classified.csv` — the four per-platform files with classification columns appended (same rows as the raw `*.csv`, nothing removed/reordered).
- `classify/classify_relevance.py` — the classifier itself; CLI usage: `python classify_relevance.py <input.csv> <output.csv> [text_column]`.
- `classify/merge_and_finalize.py` — exists but **not run** (you're merging yourself); kept in sync with the classifier's current column names in case you want to reference its filtering logic.
