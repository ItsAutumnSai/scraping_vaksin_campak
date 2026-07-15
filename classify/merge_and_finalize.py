#!/usr/bin/env python3
"""
Merges the 4 raw per-platform scrapes (scraping/out/*.csv) into the unified schema
already used by cleaned_data_2025.csv, runs semantic relevance classification
(classify_relevance.py), filters to the 2024-06-01..2026-06-30 posting window, and
writes the final dataset plus an audit trail (all scored candidates, and a separate
bucket for rows whose postdate couldn't be resolved — mainly expected from the
Facebook mbasic scrape, which often only exposes relative timestamps like "5 j").
"""
import os
import re
import sys
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from classify_relevance import score_dataframe  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "scraping", "out")

RAW_FILES = {
    "x": "x_vaccine_2024_2026.csv",
    "threads": "threads_vaccine_2024_2026.csv",
    "instagram": "instagram_vaccine_2024_2026.csv",
    "facebook": "facebook_vaccine_2024_2026.csv",
}

FINAL_COLUMNS = ["account", "postdate", "tweet", "link", "topic_tag", "comments",
                  "retweets", "likes", "shares", "replysource", "platform", "views", "page"]

WINDOW_START = pd.Timestamp("2024-06-01", tz="UTC")
WINDOW_END = pd.Timestamp("2026-07-01", tz="UTC")  # exclusive

ID_MONTHS = {
    "januari": "January", "februari": "February", "maret": "March", "april": "April",
    "mei": "May", "juni": "June", "juli": "July", "agustus": "August",
    "september": "September", "oktober": "October", "november": "November", "desember": "December",
}


def parse_postdate(raw):
    if pd.isna(raw) or str(raw).strip() == "":
        return pd.NaT
    raw = str(raw).strip()

    dt = pd.to_datetime(raw, utc=True, errors="coerce")
    if pd.notna(dt):
        return dt

    # Indonesian absolute dates, e.g. "14 Juli 2025" (Facebook mbasic <abbr> text)
    translated = raw.lower()
    for id_month, en_month in ID_MONTHS.items():
        if id_month in translated:
            translated = translated.replace(id_month, en_month)
            break
    dt = pd.to_datetime(translated, utc=True, errors="coerce", dayfirst=True)
    if pd.notna(dt):
        return dt

    # Relative/ambiguous ("5 j", "Kemarin", "Baru saja") — cannot be resolved to an
    # absolute date without knowing the exact scrape time; left unresolved.
    return pd.NaT


def load_and_reconcile():
    frames = []
    for platform, fname in RAW_FILES.items():
        path = os.path.join(OUT_DIR, fname)
        if not os.path.exists(path):
            print(f"[merge] WARNING: {path} not found, skipping {platform}")
            continue
        df = pd.read_csv(path)
        if df.empty:
            print(f"[merge] {platform}: 0 rows")
            continue
        df = df.drop_duplicates(subset=["tweet"]).copy()
        for col in FINAL_COLUMNS:
            if col not in df.columns:
                df[col] = pd.NA
        df["platform"] = platform
        frames.append(df[FINAL_COLUMNS])
        print(f"[merge] {platform}: {len(df)} rows loaded")

    if not frames:
        raise RuntimeError("No raw scrape files found in scraping/out/ — run the scrapers first.")
    return pd.concat(frames, axis=0, ignore_index=True)


def main():
    merged = load_and_reconcile()
    merged["postdate_parsed"] = merged["postdate"].apply(parse_postdate)

    print(f"[merge] {len(merged)} total merged candidates, running semantic classification...")
    scored = score_dataframe(merged, text_col="tweet")

    date_unknown = scored[scored["postdate_parsed"].isna()].copy()
    dated = scored[scored["postdate_parsed"].notna()].copy()

    in_window = dated[(dated["postdate_parsed"] >= WINDOW_START) & (dated["postdate_parsed"] < WINDOW_END)]
    final = in_window[in_window["is_relevant"]].copy()

    scored_out = scored.drop(columns=["postdate_parsed"])
    final_out = final.drop(columns=["postdate_parsed", "relevance_score", "veto_reason",
                                     "is_relevant", "borderline", "has_topic_keyword", "is_indonesian"])
    date_unknown_out = date_unknown.drop(columns=["postdate_parsed"])

    scored_path = os.path.join(ROOT, "scored_all_candidates.csv")
    final_path = os.path.join(ROOT, "cleaned_data_2024_2026.csv")
    unknown_path = os.path.join(ROOT, "date_unknown_needs_review.csv")

    scored_out.to_csv(scored_path, index=False)
    final_out.to_csv(final_path, index=False)
    date_unknown_out.to_csv(unknown_path, index=False)

    print("\n=== SUMMARY ===")
    print(f"Total merged candidates:      {len(scored)}")
    print(f"  date unresolved:            {len(date_unknown)} -> {unknown_path}")
    print(f"  in-window (2024-06..2026-06): {len(in_window)}")
    print(f"    relevant (final dataset): {len(final)} -> {final_path}")
    print(f"    borderline (in scored file, not in final): {int(in_window['borderline'].sum())}")
    print(f"    filtered out (not relevant): {int((~in_window['is_relevant']).sum())}")
    not_indonesian = int((~in_window["is_indonesian"]).sum())
    not_semantic = int((in_window["is_indonesian"] & ~in_window["is_relevant"] & ~in_window["borderline"]).sum())
    print(f"      of which, rejected for language (not Indonesian): {not_indonesian}")
    print(f"      of which, rejected for topic (Indonesian but not about vaksin campak): {not_semantic}")
    print(f"All scored candidates (audit trail): {len(scored)} -> {scored_path}")

    print("\nPer-platform breakdown (final dataset):")
    print(final["platform"].value_counts())

    print("\nMonthly distribution (final dataset):")
    monthly = pd.to_datetime(final["postdate"], utc=True, errors="coerce").dt.to_period("M").value_counts().sort_index()
    print(monthly)


if __name__ == "__main__":
    main()
