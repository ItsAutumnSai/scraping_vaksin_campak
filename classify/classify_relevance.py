#!/usr/bin/env python3
"""
Semantic relevance classifier for "vaksin campak" (measles/MR vaccine) discourse
in Indonesia — replaces literal keyword substring matching (data_cleaning_step1.ipynb),
which let through false positives like "campak" used as Malay/Indonesian slang for
"throw/discard" and "vaksin" referring to pet/livestock or unrelated vaccines.

Approach: embed each candidate post with an Indonesian sentence-transformer model,
and score it by cosine similarity against two small hand-written anchor sets (real
measles-vaccine discourse vs. the known false-positive patterns) rather than any
literal string match. Runs fully locally — no external API key or per-call cost.
"""
import re
import numpy as np
import pandas as pd
import py3langid as langid
from sentence_transformers import SentenceTransformer

# Indonesian-specific sentence embedding model, tried in priority order. The first
# is a dedicated Indonesian SBERT; the second is a well-tested multilingual
# fallback (also helps since some candidates, e.g. from X, may be English).
MODEL_CANDIDATES = [
    "firqaaa/indo-sentence-bert-base",
    "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
]

POSITIVE_ANCHORS = [
    "Kasus campak meningkat di Indonesia dan pemerintah menggencarkan imunisasi.",
    "Anak saya baru saja mendapatkan vaksin campak rubella di posyandu.",
    "Program imunisasi MR (measles rubella) untuk anak sekolah dasar.",
    "Efek samping setelah vaksin campak seperti demam ringan pada bayi.",
    "KIPI atau kejadian ikutan pasca imunisasi campak perlu dilaporkan ke puskesmas.",
    "Kampanye imunisasi nasional untuk mencegah wabah campak pada anak-anak.",
    "Dinas kesehatan mengadakan PIN campak rubella di sekolah-sekolah.",
    "Orang tua ragu memvaksin anaknya karena takut efek samping vaksin campak.",
    "Wabah campak dilaporkan terjadi di beberapa daerah dengan cakupan imunisasi rendah.",
    "Kelompok anti-vaksin menyebarkan hoaks tentang bahaya vaksin MR.",
    "Bidan dan kader posyandu mengejar target imunisasi dasar lengkap termasuk campak.",
    "Gejala campak pada anak meliputi demam tinggi dan ruam merah di kulit.",
    "Kemenkes mewajibkan vaksinasi campak sebagai bagian dari imunisasi rutin anak.",
    "Balita yang belum diimunisasi campak berisiko tertular saat terjadi KLB.",
    "Vaksinasi kejar bagi anak yang belum lengkap imunisasi campaknya.",
    "Rumah sakit merawat pasien anak akibat komplikasi campak karena belum divaksin.",
    "Sosialisasi pentingnya imunisasi campak rubella untuk mencegah kecacatan bawaan.",
    "Cakupan imunisasi campak di kabupaten ini masih di bawah target nasional.",
]

NEGATIVE_ANCHORS = [
    "Barangnya aku campak je dalam almari, tak sempat nak kemas.",
    "Dia terus campak kunci kereta atas meja lepas balik kerja.",
    "Jangan campak sampah merata-rata, letak dalam tong sampah.",
    "Kucing saya baru divaksin rabies di klinik hewan minggu lalu.",
    "Vaksinasi ternak sapi dan ayam untuk mencegah penyakit mulut dan kuku.",
    "Booster vaksin COVID-19 ketiga sudah saya terima bulan ini.",
    "Vaksin HPV penting untuk mencegah kanker serviks pada remaja putri.",
    "Dia dapat vaksin flu tahunan sebelum musim hujan tiba.",
    "Anjing peliharaan wajib divaksin rabies setiap tahun oleh dokter hewan.",
    "Measles cases are rising across Europe according to health officials.",
    "The MMR vaccine schedule in the UK differs from the US recommendation.",
    "Kkm mengadakan program vaksin percuma untuk rakyat Malaysia.",
    "Aku nak campak dia dalam sungai kalau dia buat hal lagi.",
    "Harga saham vaksin farmasi naik setelah pengumuman kuartal ini.",
    "Vaksin meningitis diperlukan sebelum berangkat umrah dan haji.",
    "Dia kena campak keluar dari geng lepas gaduh minggu lepas.",
    "Diskon vaksin influenza di apotek untuk lansia bulan ini.",
    "Ternyata mainan itu dicampakkan begitu saja di tepi jalan.",
]

# Hard topical gate: require an explicit, literal mention of the disease/vaccine
# itself (own text, or — for replies — the parent post's text via
# build_context_texts). This was added after finding that pure embedding
# similarity alone is NOT a reliable topic filter: generic Indonesian public-
# health content (puskesmas schedules, clinic ads, general parenting/baby-care
# posts, generic "imunisasi lengkap" reminders) shares enough vocabulary
# register with the positive anchors to score above any workable threshold,
# even with zero connection to measles/campak specifically. Requiring the
# literal keyword restores precision; the veto patterns below then strip out
# the literal-matching false positives (campak-as-slang, animal vaccines) that
# a naive keyword search would have let back in.
TOPIC_KEYWORD_RE = re.compile(
    r"\bcampak(?:nya|lah|kah)?\b|\brubella\b|\bmeasles\b|"
    r"\b(?:vaksin|imunisasi|suntik|vaksinasi)\s+mr\b|\bmr\s+(?:vaccine|vaksin|imunisasi)\b",
    re.I,
)

# Secondary admission path: a post/reply that discusses vaccination generically
# ("vaksin"/"imunisasi", no disease named at all — e.g. "anak saya yang 8, ada
# yang di vaksin full, ada yang sebagian") still counts as relevant, since campak
# is part of Indonesia's routine childhood immunization schedule and this is
# almost always what's implicitly meant. This does NOT apply if a *different*,
# explicitly named vaccine is present instead (COVID, HPV, flu, animal vaccines,
# other routine-schedule diseases) — those are still excluded, since the row is
# then clearly about that other vaccine, not an ambiguous/implicit reference.
GENERIC_VACCINE_RE = re.compile(r"\b(vaksin|vaksinasi|imunisasi)\b", re.I)
OTHER_SPECIFIC_VACCINE_RE = re.compile(
    r"\b(covid-?19|covid|corona|hpv|influenza|flu|rabies|meningitis|hepatitis|tifoid|tifus|kolera|"
    r"difteri|pertusis|tetanus|dpt|bcg|polio|kucing|anjing|hewan|ternak|sapi|ayam|kambing|kuda|babi|"
    r"umrah|haji|demam\s+kuning|yellow\s+fever|ev-?71|hfmd|tangan\s+kaki\s+mulut|rsv|beyfortus)\b", re.I)
# The generic-vaccine fallback turned out to be too permissive on its own: a
# clinic/business post that just lists "Imunisasi" as one of several services,
# or mentions it as an aside ("jangan pijat bayi setelah imunisasi"), isn't
# genuine vaccine sentiment/opinion — it's an ad that happens to touch the
# word. This veto only applies to the generic fallback path, not an explicit
# campak/rubella/MR match (TOPIC_KEYWORD_RE) — an ad for the actual measles
# vaccine is still legitimately on-topic even though it's promotional.
AD_VETO_RE = re.compile(
    r"harga|rp\s?\d|promo|diskon|reservasi|pendaftaran|daftar\s|klinik|puskesmas|\brsia\b|\brsud\b|"
    r"rumah\s+sakit|jadwal\s+(layanan|praktek|pelayanan|puskesmas)|pricelist|price\s*list|hubungi|"
    r"wa\s?0\d|whatsapp|kontak|admin|booking|kuota|slot\s+terbatas|link\s+di\s+bio|dm\s+kami|"
    r"buka\s+pendaftaran|📱|☎", re.I)

# High-precision regex vetoes, layered on top of the topical gate — catch the
# exact literal-matching failure modes the user described (bare "campak" used
# as slang for throw/discard rather than the disease name).
VETO_PATTERNS = [
    (re.compile(r"\bvaksin(?:asi)?\s+(kucing|anjing|hewan|ternak|sapi|ayam|babi|kambing|kuda|rabies)\b", re.I),
     "animal_vaccine"),
    (re.compile(r"\bdicampak(?:kan)?\b", re.I), "campak_as_discard"),
    # Broadened after finding real misses: "campak ke DARAT menjadi gunung"
    # (folklore text — thrown to land) wasn't caught because the destination
    # list only had laut/sungai/tong; "campak bayi dari tingkat 38" (Malaysian
    # news — threw a baby) wasn't caught at all since it takes a direct
    # object instead of a "ke <place>" phrase. The disease sense of "campak"
    # never takes a direct object or "ke/dari <place>" — any of those is a
    # reliable signal of the throw/discard verb sense instead.
    (re.compile(r"\bcampak(?:kan)?\s+(je|jer|sahaja|dalam|dlm|atas|kat|tu|itu|ni|nih|"
                r"ke\s+\w+|dari\s+\w+)\b", re.I), "campak_as_throw"),
]

# "campak" + a direct-object noun (a baby, an animal, an item) is unlike the
# other veto patterns above: it's unambiguous — nobody writes "campak bayi" to
# mean "measles baby" — there's no plausible genuinely-relevant reading to
# protect against false-suppressing. Verified this matters in practice: "Wanita
# campak bayi dari tingkat 38 dipenjara dua tahun" (Malaysian news story about
# a woman who threw a baby) scored 0.20, ABOVE VETO_CONFIDENCE_CEILING, so the
# soft-veto mechanism below would have let it through uncaught. This one is a
# hard veto — always applied, not subject to the confidence-ceiling override.
HARD_VETO_PATTERNS = [
    (re.compile(r"\bcampak\s+(bayi|anak|kucing|anjing|barang|sampah|kunci|baju|mainan|"
                r"botol|dompet|hp|telefon|beg|kertas|sepatu|kasut)\b", re.I),
     "campak_as_throw_object"),
]

# --- Hard language gate ---
# The user was explicit: this dataset must be Indonesian only — no English,
# Japanese, Malay, or anything else, regardless of what the embedding
# similarity score says. Embedding similarity alone is NOT a reliable language
# filter: e.g. an English sentence about the MMR vaccine can still score
# reasonably close to Indonesian vaccine-discourse anchors because the TOPIC
# overlaps, even though the language doesn't. This gate runs independently of,
# and before, semantic scoring — nothing skips it.
#
# Two layers, mirroring scraping/lib/locale.js (Node side, used as a coarse
# scrape-time pre-filter — this is the stricter, authoritative Python-side
# gate applied at final classification time):
#   1. py3langid rejects anything outside the Indonesian/Malay/regional-
#      Austronesian cluster outright (English, Japanese, Swahili, etc.).
#   2. Indonesian and Malay are mutually intelligible and neither langid nor
#      any statistical language-ID model reliably tells them apart on short,
#      informal social-media text (verified empirically: both franc.js and
#      py3langid misclassify real examples in both directions ~30% of the
#      time). Within that cluster, fall back to colloquial-marker word lists
#      tuned specifically for this ID-vs-MY distinction.
AUSTRONESIAN_CLUSTER = {"id", "ms", "jv", "su", "min", "bug", "ban", "ace", "mad", "bjn"}

# Two groups: word-bounded state/agency names (kept \b-anchored since some,
# e.g. "perak", collide with ordinary Indonesian words — "perak" means
# "silver"/slang for "cash" in Indonesian too, so it must NOT be a bare
# substring match), and a set of highly distinctive terms searched as plain
# substrings with no boundary at all. The substring group exists because real
# Malaysian content routinely glues these into hashtags/mentions/domains
# ("#malaysiagazette", "@KKMPutrajaya", "myhealthkkm", "#KKMPrihatin",
# "bernama.com") — a \b-anchored match silently fails there since there's no
# word-boundary transition on one side, letting clearly-Malaysian posts pass
# as Indonesian. Verified against real X data: none of those four examples
# were caught before this fix.
MALAYSIA_WORDS_RE = re.compile(
    r"\b(kedah|selangor|penang|pulau pinang|johor|melaka|jkn_|mygov|kkmm|"
    r"sarawak|sabah|terengganu|kelantan|pahang|labuan|putrajaya|kesihatan|"
    r"batu pahat)\b|"
    r"malaysia|kkm|bernama\.com|bernamanews|mysejahtera", re.I)
MALAY_ONLY_MARKERS_RE = re.compile(
    # "tak", "kau", and "nak" were removed from this list after finding a false
    # reject: "Tak usai di bahas" is ordinary Indonesian ("tak" = short for
    # "tidak", used in standard/informal Indonesian too, not Malay-exclusive),
    # but it tripped malay_hits>0/id_hits==0 and hard-rejected a genuinely
    # Indonesian post. All three are common enough in Indonesian (informal
    # "kau", vocative "nak") that they're not reliable ID-vs-MY discriminators.
    # wabak/tempah/ubat/pesakit added after finding real misses in health-news
    # content: Malay spells "outbreak" as "wabak" (Indonesian: "wabah"), "book/
    # reserve" as "tempah" (Indonesian: "pesan"), "medicine" as "ubat"
    # (Indonesian: "obat"), "patient" as "pesakit" (Indonesian: "pasien") — none
    # of these four exist in standard Indonesian at all, so they're safe,
    # high-precision markers.
    r"\b(korang|kitorang|dorang|depa|hang|awak|mcm|giler|weyy|takyah|takde|takpe|xde|xleh|"
    r"xnak|xtau|dkt|kt|kat|nk|je|jer|sahaja|kene|bwh|lesen|amik|kereta|rasuah|tamadun|cikgu|"
    r"longkang|siasat|disiasat|wabak|tempah|ubat|pesakit|ambik|menghidap|pramatang)\b|"
    # "kanak-kanak"/"kanak kanak" (Malay for "children"; Indonesian says
    # "anak-anak") is a real marker missed in health-news content ("kadar
    # kematian bayi dan kanak-kanak menurun"), but bare-word matching collides
    # with "Taman Kanak-Kanak", the standard Indonesian term for kindergarten
    # — excluded via the negative lookbehind instead of dropping the marker.
    r"(?<!taman )\bkanak[-\s]kanak\b", re.I)
INDONESIAN_ONLY_MARKERS_RE = re.compile(
    r"\b(gak|enggak|nggak|gue|gua|elo|banget|udah|emang|bikin|pake|gimana|gitu|nih|dong|sih|deh|"
    r"kok|apaan|soalnya|kayak|ngerasa|ngerti|jadinya|beneran)\b", re.I)

# Indonesian/Malay are always written in Latin script in this dataset — any
# CJK/Kana/Hangul/Arabic/Cyrillic/Thai character is an instant, cheap, and
# fully reliable reject regardless of text length. Added after finding short
# (<15 char) Chinese/Japanese text falling through: the langid check below is
# gated on len(text) >= 15 (to avoid langid noise on very short text), which
# meant e.g. "这是中文文本" (6 chars) and "日本語のテキストです" (10 chars) never
# hit langid at all, had zero Malay markers, and fell through to the "assume
# Indonesian" default at the bottom of this function.
NON_LATIN_SCRIPT_RE = re.compile(
    r"[一-鿿぀-ヿ゠-ヿ가-힯؀-ۿЀ-ӿ฀-๿]")


def is_strictly_indonesian(text):
    """Hard gate: True only for text confidently identified as Indonesian
    (not Malay, not any other language). Mirrors lib/locale.js's two-layer
    approach but is the authoritative check for the final dataset."""
    if not isinstance(text, str) or not text.strip():
        return False
    if NON_LATIN_SCRIPT_RE.search(text):
        return False
    if MALAYSIA_WORDS_RE.search(text):
        return False

    malay_hits = len(MALAY_ONLY_MARKERS_RE.findall(text))
    id_hits = len(INDONESIAN_ONLY_MARKERS_RE.findall(text))

    flagged_english = False
    # Only consult langid's hard-reject path when there's no positive
    # Indonesian marker evidence to protect — verified empirically that
    # langid misfires badly on short/informal Indonesian text (e.g. "lucu
    # banget videonya wkwkwk" was classified as Kinyarwanda). A clear marker
    # like "banget" is higher-precision than a statistical guess on a dozen
    # words, so it must not get overridden by one.
    if len(text) >= 15 and id_hits == 0:
        lang, _ = langid.classify(text)
        if lang not in AUSTRONESIAN_CLUSTER and lang != "en":
            # Clean non-Austronesian, non-English call — reject outright
            # (Japanese, Swahili, etc.); no plausible false-positive path here.
            return False
        if lang == "en":
            # langid sometimes says "en" for genuinely Indonesian slang-heavy
            # posts (lots of English loanwords) — don't hard-reject purely on
            # this signal, but remember it: it removes the "no markers either
            # way -> assume Indonesian" benefit of the doubt below, so a
            # langid="en" call with zero Indonesian markers is rejected,
            # while one with real Indonesian markers still passes.
            flagged_english = True

    if malay_hits > 0 and id_hits == 0:
        return False
    if malay_hits >= 2 and id_hits < 2:
        return False
    if id_hits > 0:
        return True
    if flagged_english:
        return False
    # No colloquial markers either way (formal/news-register text reads the
    # same in Indonesian and Malay) and langid didn't say English — treat as
    # plausibly Indonesian unless a Malay marker fired above; the semantic
    # classifier's Malay-context negative anchors are the secondary safety
    # net for this residual case.
    return malay_hits == 0

# NOTE: is_relevant is now gated primarily by TOPIC_KEYWORD_RE (see above), not
# by this threshold — pure embedding similarity turned out to score generic
# Indonesian public-health content (puskesmas schedules, clinic ads, general
# parenting posts) above any workable cutoff, since it shares vocabulary
# register with the positive anchors without ever mentioning measles/campak.
# UPPER_THRESHOLD now only gates the secondary "flag for review" bucket: rows
# with no literal keyword match but a high score anyway (typos/rare phrasing
# the regex gate might miss).
UPPER_THRESHOLD = 0.08
# Regex vetoes are a backstop for cases the embedding score misses, not an override
# for cases it already gets right — e.g. "padahal pas kecil udah divaksin campak,
# kok sekarang masih dicampakkan?" trips the campak_as_discard veto via wordplay
# but is genuinely about measles vaccination and scores well above VETO_CONFIDENCE_CEILING.
# Only let a veto suppress rows the model itself isn't already confident about.
VETO_CONFIDENCE_CEILING = 0.15
# A literal keyword match alone isn't sufficient: "campak" also shows up in
# purely incidental contexts with zero vaccine-discourse content — e.g. a
# movie-synopsis post about Gertrude Ederle noting she "nyaris tewas karena
# sakit campak" as a childhood biography detail. That case scored -0.088
# (clearly negative) despite matching TOPIC_KEYWORD_RE, confirming the
# embedding score is a reliable enough signal to catch this specific failure
# mode even though it can't be trusted as the PRIMARY gate (see note above).
# Below this floor, a keyword match is downgraded to borderline instead of
# auto-included — mirrors the VETO_CONFIDENCE_CEILING mechanism.
TOPIC_SCORE_FLOOR = -0.03


def load_model():
    last_err = None
    for name in MODEL_CANDIDATES:
        try:
            model = SentenceTransformer(name)
            print(f"[classify_relevance] loaded model: {name}")
            return model, name
        except Exception as e:
            print(f"[classify_relevance] failed to load {name}: {e}")
            last_err = e
    raise RuntimeError(f"No embedding model could be loaded: {last_err}")


def cosine_sim_matrix(a, b):
    a_norm = a / np.linalg.norm(a, axis=1, keepdims=True).clip(min=1e-9)
    b_norm = b / np.linalg.norm(b, axis=1, keepdims=True).clip(min=1e-9)
    return a_norm @ b_norm.T


def apply_veto(text):
    if not isinstance(text, str):
        return None
    for pattern, reason in VETO_PATTERNS:
        if pattern.search(text):
            return reason
    return None


def apply_hard_veto(text):
    if not isinstance(text, str):
        return None
    for pattern, reason in HARD_VETO_PATTERNS:
        if pattern.search(text):
            return reason
    return None


def build_context_texts(df, text_col, link_col="link", replysource_col="replysource"):
    """
    A reply like "iya aku setuju" carries zero vaccine-related content on its
    own — scored in isolation it reads as pure noise and gets wrongly excluded,
    even though it's clearly part of the discourse (e.g. agreeing with a post
    that's hating on vaksin campak rubella). Since the whole point of this
    dataset is to read people's opinion (positive or negative) on the topic,
    comments are actually some of the most valuable rows — sentiment shows up
    more in short reactions than in the original announcement-style posts.
    For any row that IS a reply (replysource points to a real parent link,
    not "NaN"/empty), prepend the parent post's own text before embedding, so
    the model scores the reply's relevance in the context of what it's
    actually replying to. Falls back to the row's own text if no matching
    parent is found in the same dataframe (e.g. parent got de-duplicated out).
    """
    if link_col not in df.columns or replysource_col not in df.columns:
        return df[text_col].fillna("").astype(str).tolist()

    link_to_text = dict(zip(df[link_col].astype(str), df[text_col].fillna("").astype(str)))
    out = []
    for own_text, replysource in zip(df[text_col].fillna("").astype(str), df[replysource_col].astype(str)):
        is_reply = replysource and replysource != "nan" and replysource != "NaN"
        parent_text = link_to_text.get(replysource) if is_reply else None
        if parent_text:
            out.append(f"{parent_text} — Balasan: {own_text}")
        else:
            out.append(own_text)
    return out


def score_dataframe(df, text_col="tweet", batch_size=64):
    """Adds relevance_score, is_relevant, borderline, veto_reason columns to df (returns a copy)."""
    model, model_name = load_model()
    # Raw text (own row only) is used for the language gate and veto checks —
    # those should judge what THIS row itself says/is written in. The
    # embedding score uses parent-augmented context for replies (see
    # build_context_texts) so short, context-dependent comments aren't
    # penalized for not repeating the topic themselves.
    texts = df[text_col].fillna("").astype(str).tolist()
    embedding_texts = build_context_texts(df, text_col)

    pos_emb = model.encode(POSITIVE_ANCHORS, convert_to_numpy=True, normalize_embeddings=False)
    neg_emb = model.encode(NEGATIVE_ANCHORS, convert_to_numpy=True, normalize_embeddings=False)

    text_emb = model.encode(embedding_texts, convert_to_numpy=True, batch_size=batch_size,
                             show_progress_bar=True, normalize_embeddings=False)

    pos_sims = cosine_sim_matrix(text_emb, pos_emb)
    neg_sims = cosine_sim_matrix(text_emb, neg_emb)

    k = 3
    pos_score = np.sort(pos_sims, axis=1)[:, -k:].mean(axis=1)
    neg_score = np.sort(neg_sims, axis=1)[:, -k:].mean(axis=1)
    relevance_score = pos_score - neg_score

    out = df.copy()
    out["relevance_score"] = relevance_score
    raw_veto = pd.Series([apply_veto(t) for t in texts], index=out.index)
    # A soft veto only counts if the model isn't already confident this is
    # relevant. Hard vetoes (unambiguous patterns — see HARD_VETO_PATTERNS)
    # always apply regardless of score.
    hard_veto = pd.Series([apply_hard_veto(t) for t in texts], index=out.index)
    veto_active = (raw_veto.notna() & (relevance_score <= VETO_CONFIDENCE_CEILING)) | hard_veto.notna()
    out["veto_reason"] = raw_veto.where(raw_veto.notna() & (relevance_score <= VETO_CONFIDENCE_CEILING)).fillna(hard_veto)

    # Hard language gate — independent of and prior to everything else below.
    is_indonesian = pd.Series([is_strictly_indonesian(t) for t in texts], index=out.index)
    out["is_indonesian"] = is_indonesian

    # Hard topical gate, checked on the context-augmented text so a reply that
    # never says "campak" itself still passes when its parent post does (see
    # build_context_texts). This is the primary admission control — see
    # TOPIC_KEYWORD_RE's comment for why raw embedding similarity alone let
    # too much generic health content through.
    specific_topic_match = pd.Series(
        [bool(TOPIC_KEYWORD_RE.search(t)) for t in embedding_texts], index=out.index)
    # Secondary path: generic "vaksin"/"imunisasi" mention with no disease named
    # at all (see GENERIC_VACCINE_RE's comment) also counts, unless a different
    # specific vaccine is named instead.
    generic_vaccine_match = pd.Series(
        [bool(GENERIC_VACCINE_RE.search(t)) and not OTHER_SPECIFIC_VACCINE_RE.search(t)
         and not AD_VETO_RE.search(t)
         for t in embedding_texts], index=out.index)
    has_topic_keyword = specific_topic_match | generic_vaccine_match
    out["has_topic_keyword"] = has_topic_keyword

    # A keyword match with a clearly negative score (see TOPIC_SCORE_FLOOR's
    # comment — catches incidental non-vaccine mentions like a movie synopsis
    # noting a character "nyaris tewas karena sakit campak") is downgraded to
    # borderline rather than auto-included.
    low_score_flag = has_topic_keyword & (relevance_score < TOPIC_SCORE_FLOOR)

    out["is_relevant"] = is_indonesian & has_topic_keyword & ~veto_active & ~low_score_flag
    # Kept for manual review, not auto-included: (a) keyword present but veto
    # tripped (ambiguous "campak" usage the model itself isn't confident is a
    # discard-slang case), (b) keyword present but score is clearly negative
    # (likely incidental, non-vaccine mention), or (c) no literal keyword but
    # a very high semantic score anyway (catches typos/rare phrasing the regex
    # gate might miss).
    ambiguous_veto = is_indonesian & has_topic_keyword & veto_active
    low_score_review = is_indonesian & has_topic_keyword & ~veto_active & low_score_flag
    high_score_no_keyword = is_indonesian & ~has_topic_keyword & (relevance_score > UPPER_THRESHOLD)
    out["borderline"] = ambiguous_veto | low_score_review | high_score_no_keyword
    return out


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python classify_relevance.py <input.csv> <output.csv> [text_column]")
        sys.exit(1)
    in_path, out_path = sys.argv[1], sys.argv[2]
    text_col = sys.argv[3] if len(sys.argv) > 3 else "tweet"
    df = pd.read_csv(in_path)
    scored = score_dataframe(df, text_col=text_col)
    scored.to_csv(out_path, index=False)
    print(f"relevant={scored['is_relevant'].sum()} borderline={scored['borderline'].sum()} "
          f"total={len(scored)} -> {out_path}")
