#!/usr/bin/env python3
"""Apply house_overrides.json to an existing reference.db.

Updates house_items color1/color2, house_item_images URLs, and images table
entries for villagers whose Nookipedia data had empty image_url fields.

Usage:
  python3 scripts/apply_overrides.py                     # apply to dev-data/ref/reference.db
  python3 scripts/apply_overrides.py path/to/other.db    # apply to specific db
"""
import json
import os
import re
import sqlite3
import sys
import unicodedata
import html as _html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OVERRIDES_PATH = os.path.join(ROOT, "scripts", "house_overrides.json")
DEFAULT_DB = os.path.join(ROOT, "dev-data", "ref", "reference.db")


def sanitize_filename(s):
    s = _html.unescape(str(s))
    s = s.replace('\u2190', 'left').replace('\u2192', 'right')
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii')
    s = s.lower().replace(' ', '_').replace('-', '_')
    s = re.sub(r'[^\w.]', '', s)
    s = re.sub(r'_+', '_', s).strip('_.')
    return s


def load_overrides():
    with open(OVERRIDES_PATH) as f:
        data = json.load(f)
    return {k: v for k, v in data.items() if not k.startswith('_')}


def load_xlsx_lookup():
    """Load variant lookup from xlsx (same as build_db.py)."""
    sys.path.insert(0, os.path.join(ROOT, "scripts"))
    from build_db import load_workbook, build_variant_lookup
    _, sheets = load_workbook()
    return build_variant_lookup(sheets)


def apply(db_path=None):
    db_path = db_path or DEFAULT_DB
    overrides = load_overrides()
    if not overrides:
        print("No overrides found.")
        return

    lookup = load_xlsx_lookup()
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    applied = 0
    skipped = 0
    errors = []

    for key, var in overrides.items():
        villager, item_name = key.split("/", 1)
        norm_name = re.sub(r'[\s-]+', ' ', item_name.strip().lower())
        opts = lookup.get(norm_name)
        if not opts:
            errors.append(f"  {key}: item not in xlsx")
            skipped += 1
            continue

        from build_db import resolve_house_variant
        hit = resolve_house_variant(opts, var)
        if not hit:
            errors.append(f"  {key}: variant {var!r} not found")
            skipped += 1
            continue

        # Check if colors actually changed
        cur.execute(
            "SELECT color1, color2 FROM house_items WHERE villager=? AND name=?",
            (villager, hit["name"]),
        )
        row = cur.fetchone()
        if row and row[0] == hit["c1"] and row[1] == hit["c2"]:
            continue  # already correct

        # Update house_items
        cur.execute(
            "UPDATE house_items SET color1=?, color2=? WHERE villager=? AND name=?",
            (hit["c1"], hit["c2"], villager, hit["name"]),
        )

        # Update images table — replace the old row with the correct variant
        back_var = (hit.get("var_raw") or "").strip().lower()
        if back_var in ("", "na", "none"):
            back_var = ""
        img_fn = sanitize_filename(hit["name"]) + (f"_{sanitize_filename(back_var)}" if back_var else "") + ".png"
        img_url = f"/img/{sanitize_filename(hit['category'])}/{img_fn}"

        # Delete any existing rows for this item (all variations), then insert correct one
        cur.execute(
            "DELETE FROM images WHERE lower(category)=lower(?) AND name=?",
            (hit["category"], hit["name"]),
        )
        cur.execute(
            "INSERT INTO images (category, name, variation, url) VALUES (?, ?, ?, ?)",
            (hit["category"], hit["name"], back_var, img_url),
        )

        # Update house_item_images
        house_img_url = f"/img/{sanitize_filename(villager)}/{sanitize_filename(hit['name'])}.png"
        cur.execute(
            "UPDATE house_item_images SET url=? WHERE villager=? AND name=?",
            (house_img_url, villager, hit["name"]),
        )

        applied += 1
        print(f"  {key}: c1={hit['c1']}, c2={hit['c2']}")

    conn.commit()
    conn.close()

    print(f"\nApplied: {applied}, Skipped: {skipped}")
    if errors:
        print("Errors/skipped:")
        for e in errors:
            print(e)


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else None
    apply(db)
