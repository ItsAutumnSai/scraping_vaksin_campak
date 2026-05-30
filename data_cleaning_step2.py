"""
Filter merged_data.csv to keep only rows related to campak (measles) vaccination.

Removes:
  - Malay "campak" used as verb "throw/toss/send"
  - Indonesian "dicampakkan" puns (wordplay about being romantically dumped)
  - Tweets only about non-campak vaccines (DPT, rotavirus, BCG, influenza, HPV, etc.)
  - General vaccination/health content with no campak connection
  - Completely unrelated content

Usage:
    python filter_campak.py
    python filter_campak.py --input path/to/input.csv --output path/to/output.csv
"""

import csv
import re
import sys
import argparse
from collections import defaultdict

DEFAULT_INPUT  = 'latest/merged_data.csv'
DEFAULT_OUTPUT = 'latest/merged_data.csv'


def classify(tweet_text, platform):
    text = tweet_text.lower()

    # ── 1. MALAY THROW DETECTION ──────────────────────────────────────────────
    throw_phrases = [
        'campak ke laut', 'campak kat laut', 'campak dalam laut', 'campak ke sungai',
        'campak dalam sungai', 'campak dalam gaung', 'campak masuk gaung', 'campak gaung',
        'campak longkang', 'campak dalam longkang', 'campak dalam api', 'campak dalam tong',
        'campak tong sampah', 'campak ke gaung', 'campak bawah bas', 'campak bawah lori',
        'campak phone', 'campak pjone', 'campak fon', 'campak hp ', 'campak racket',
        'campak beg ', 'campak mercun', 'campak smoke bomb', 'campak sudu', 'campak buku',
        'campak parcel', 'campak monitor', 'campak camera', 'campak barang',
        'campak battery', 'campak plastik', 'campak bantal', 'campak kucing', 'campak baby ',
        'campak mayat', 'campak sana sini', 'campak kesana kesini',
        'campak campak je', 'campak-campak je', 'campak campak pun', 'campak campak tu',
        'campak merata', 'campak mana mana', 'campak kat muka', 'campak kat kepala',
        'campak kat dahi', 'campak kat laut', 'campak dekat sungai', 'campak baling',
        'lambung campak', 'campak tepi highway', 'campak jauh-jauh', 'campak jauh2',
        'campak semua dalam', 'campak dalam periuk', 'campak ramuan',
        'campak semua benda', 'campak dalam tv',
        'kena campak kat sg', 'kena campak kat p', 'kena campak ke p',
        'kena campak kat meeting', 'kena campak sini', 'kena campak ke ',
        'di campak bersama', 'campak kat sg', 'campak kat kedah', 'campak ke johor',
        'campak ke kelantan', 'campak ke pahang', 'campak ke ganu', 'campak ke kl',
        'campak kat korea', 'campak ke korea', 'campak ke bangkok',
        'campak aku ke', 'campak aku kat', 'campak saya ke',
        'campak masuk planning', 'campak campak pun sedap',
        'campak bahan ', 'campak dalam peti',
        'campak atas katil', 'campak bawah je', 'campak lantai',
        'campak tepi', 'campak ego ', 'campak rule of law', 'campak maruah',
        'haroqs', 'campak coklat ke', 'campak gula2 ke', 'campak gula ke',
        'campak an ang',
        'nak campak phone', 'nak campak je', 'nak campak orang', 'nak campak pc',
        'sikit lagi nak campak', 'hampir campak phone',
        'campak duit', 'campak tiket',
        'campak kat sini', 'campak ke sini', 'campak ke sana', 'campak kat sana',
        'campak jauh ', 'campak kat zoo', 'campak lagi coklat', 'campak lagi gula',
        'campak dari tingkat', 'campak dari bangunan',
        'campak buaya', 'campak kat buaya', 'campak bagi makan',
        'campak je la', 'campak jela ', 'campak jelah',
        'campak diri ke', 'campak motor ', 'campak beskal',
        'campak pinggir', 'campak tepi pantai', 'campak ke pantai',
    ]

    is_throw = any(phrase in text for phrase in throw_phrases)
    if not is_throw:
        throw_patterns = [
            r'\bcampak\b.{1,15}\b(kat laut|ke laut|dalam laut|dalam sungai|dalam gaung|bawah bas|dari tingkat|dari bangunan|dalam api)\b',
            r'\b(nak|hampir|sikit lagi nak)\s+campak\b',
            r'\bcampak\b.{1,10}(buaya|harimau|jerung|gaung|longkang|tong sampah|furnace)',
        ]
        for pat in throw_patterns:
            if re.search(pat, text):
                is_throw = True
                break

    # ── 2. STRONG CAMPAK DISEASE / VACCINE INDICATORS ────────────────────────
    strong_kw = [
        'vaksin campak', 'imunisasi campak', 'suntik campak', 'cucuk campak',
        'cucuk demam campak', 'cucuk vaksin campak',
        'demam campak', 'bintik campak', 'ruam campak', 'virus campak',
        'penyakit campak', 'sakit campak', 'sembuh campak',
        'campak pneumonia', 'pneumonia campak', 'komplikasi campak', 'campak komplikasi',
        'wabah campak', 'klb campak', 'kasus campak', 'pasien campak', 'suspek campak',
        'suspect campak', 'campak menewaskan', 'bahaya campak', 'gejala campak',
        'ciri campak', 'campak menyebar', 'waspada campak', 'cegah campak',
        'campak melonjak', 'campak di indonesia', 'campak di as', 'campak di texas',
        'campak di sumenep', 'campak di pekanbaru', 'campak di cilegon',
        'campak meningkat', 'campak kembali', 'bias campak', 'ori campak',
        'campak bisa dicegah', 'campak itu bukan', 'campak bukan sekedar',
        'campak bukan sekadar', 'lindungi dari campak', 'hentikan demam campak',
        '#vaksincampak', '#campak',
        'vaksin mr ', 'vaksin mmr', 'imunisasi mr', 'imunisasi mmr',
        'measles rubella', 'measles-rubella', 'mr vaccine', 'mmr vaccine',
        'campak rubella', 'campak dan rubella', 'campak jerman', 'campak german',
        'measles', 'morbili', 'morbillivirus', 'german measles',
        'penularan campak', 'infeksi campak', 'campak pada anak', 'campak menyerang',
        'campak menular', 'gondongan', 'gondongen', 'tampek',
        'campak di wilayah', 'penyebaran campak', 'campak merebak',
        'imunisasi measles', 'measles & rubella', 'measles and rubella',
        'rubella', 'campak sumenep', 'campak texas', 'campak israel',
        'kena campak', 'adanya campak', 'terkena campak', 'menderita campak',
        'korban campak', 'meninggal campak', 'campak meninggal',
    ]

    strong = any(kw in text for kw in strong_kw)
    if not strong:
        if re.search(r'\b(mmr|vaksin mr)\b.{0,30}\bcampak\b', text):
            strong = True
        if re.search(r'\bcampak\b.{0,30}\b(mmr|vaksin mr)\b', text):
            strong = True

    has_campak = 'campak' in text

    # ── 3. PUN DETECTION (check before strong to catch wordplay tweets) ───────
    pun = False
    if 'dicampak' in text and has_campak:
        pun_patterns = [
            r'vaksin campak.{0,120}dicampak',
            r'suntik campak.{0,120}dicampak',
            r'dicampak.{0,120}vaksin campak',
            r'dicampak.{0,120}suntik campak',
            r'biar (ga|gak|tak|tidak) dicampak',
            r'supaya (ga|gak|tak|tidak) dicampak',
            r'(dah|udah|habis) vaksin.{0,50}dicampak',
            r'(padahal|percuma).{0,10}(vaksin|suntik) campak.{0,100}dicampak',
            r'(dulu|dah|udah).{0,30}(vaksin|suntik) campak.{0,100}dicampak',
            r'(pas|waktu) kecil.{0,50}vaksin campak.{0,100}dicampak',
            r'(kalo|kalau|buat apa).{0,30}vaksin campak.{0,100}dicampak',
        ]
        for pat in pun_patterns:
            if re.search(pat, text):
                pun = True
                break
        if not pun:
            if 'di campkan' in text and ('vaksin campak' in text or 'suntik campak' in text):
                pun = True

    if pun:
        real_content_kw = ['klb', 'wabah', 'pasien campak', 'komplikasi campak',
                           'campak pneumonia', 'campak menewaskan', 'gejala campak',
                           'campak menyebar', 'campak meningkat']
        if not any(kw in text for kw in real_content_kw):
            return 'REMOVE_PUN', 'Indonesian pun: campak vaccine wordplay about being "dumped/rejected" (dicampakkan)'

    # ── 4. DECISION TREE ──────────────────────────────────────────────────────
    if is_throw and strong:
        dominant = [
            'wabah campak', 'klb campak', 'kasus campak', 'pasien campak',
            'campak pneumonia', 'campak menewaskan', 'demam campak',
            'vaksin campak', 'imunisasi campak', 'bahaya campak',
            'gejala campak', 'campak menyebar', 'measles',
            'campak meningkat', 'campak melonjak', 'campak di ',
        ]
        if any(kw in text for kw in dominant):
            return 'KEEP', None
        return 'REMOVE_THROW', 'Malay "campak" (throw) with incidental campak disease mention'

    if is_throw:
        return 'REMOVE_THROW', 'Malay "campak" used as verb "throw/toss/send" — not measles disease'

    if strong:
        return 'KEEP', None

    if has_campak:
        return 'KEEP', None

    # Non-campak vaccines only
    non_campak_kw = [
        'vaksin dpt', 'imunisasi dpt', 'vaksin bcg', 'imunisasi bcg',
        'vaksin pcv', 'imunisasi pcv', 'vaksin rotavirus', 'imunisasi rotavirus',
        'vaksin influenza', 'imunisasi influenza', 'vaksin hepatitis',
        'vaksin hpv', 'imunisasi hpv', 'vaksin varicella', 'vaksin cacar air',
        'vaksin dengue', 'vaksin dbd', 'vaksin tifoid', 'vaksin typhoid',
        'vaksin polio', 'imunisasi polio', 'imunisasi tb', 'vaksin tb', 'vaksin tbc',
        'imunisasi gigi', 'vaksin gigi', 'vaksin hfmd', 'vaksin flu',
        'vaksin je ', 'vaksin tetanus', 'vaksin rabies', 'vaksin malaria',
        'vaksinasi polio', 'vaksinasi hpv', 'vaksinasi dengue', 'vaksinasi hepatitis',
        'vaksinasi dbd', 'vaksinasi tb',
    ]
    if any(kw in text for kw in non_campak_kw):
        return 'REMOVE_OTHER_VACCINE', 'Only non-campak vaccines (DPT/rotavirus/BCG/influenza/HPV/polio/dengue etc.)'

    health_kw = [
        'imunisasi', 'vaksinasi', 'vaksin', 'penyakit', 'kesehatan',
        'kesihatan', 'virus', 'infeksi', 'dokter', 'rumah sakit', 'klinik', 'hospital',
    ]
    if any(kw in text for kw in health_kw):
        return 'REMOVE_OTHER_VACCINE', 'General health/vaccination content without campak connection'

    return 'REMOVE_UNRELATED', 'No campak or health connection'


def main():
    parser = argparse.ArgumentParser(description='Filter merged_data.csv for campak-related rows only.')
    parser.add_argument('--input',  default=DEFAULT_INPUT,  help='Input CSV path')
    parser.add_argument('--output', default=DEFAULT_OUTPUT, help='Output CSV path')
    parser.add_argument('--report', action='store_true',    help='Print removal report')
    args = parser.parse_args()

    with open(args.input, encoding='utf-8') as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = reader.fieldnames

    kept, removed = [], []
    reason_counts = defaultdict(int)
    removal_examples = defaultdict(list)

    for i, row in enumerate(rows):
        cat, reason = classify(row['tweet'], row['platform'])
        if cat == 'KEEP':
            kept.append(row)
        else:
            removed.append((i + 1, row, cat, reason))
            reason_counts[reason] += 1
            if len(removal_examples[reason]) < 5:
                removal_examples[reason].append((i + 1, row['platform'], row['tweet'][:150]))

    with open(args.output, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(kept)

    print(f"Done.  {len(rows)} → {len(kept)} rows  (removed {len(removed)})")
    print(f"Saved: {args.output}")

    if args.report:
        print()
        print("=== Removal Breakdown ===")
        for reason, count in sorted(reason_counts.items(), key=lambda x: -x[1]):
            print(f"  {count:4d}  {reason}")
        print()
        print("=== Examples by category ===")
        for reason, examples in sorted(removal_examples.items()):
            print(f"\n{'─'*60}")
            print(f"{reason}  [{reason_counts[reason]} rows]")
            print('─' * 60)
            for row_num, plt, tweet in examples:
                print(f"  Row {row_num:4d} [{plt}]: {tweet.replace(chr(10), ' ')}")


if __name__ == '__main__':
    main()
