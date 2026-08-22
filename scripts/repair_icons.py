#!/usr/bin/env python3
"""Repair pass for missing gift-catalog icons in an ALREADY-BUILT ref DB.

The 2026-08-21 build left ~320 gift items (baby bed, backlit sign, Nordic
series, ...) without icons: the generic fetch guessed wrong filenames and its
registry fallback probed lowercase prefixes, which MediaWiki rejects after the
first character. build_db.registry_icon_for() now handles this at build time;
this script backfills a built dev-data/ref tree WITHOUT re-fetching everything:

  1. audit items (gift categories) vs images table + files on disk
  2. resolve each hole via registry_icon_for (network, disk-cached)
  3. write webp via save_image, INSERT OR REPLACE INTO images
  4. rewrite images.zip + img/manifest.json (hash/count/urls)
  5. update meta.image_hash, VACUUM, regzip reference.v1.db.gz atomically

Safe to re-run: resolved items are cached on disk; already-present rows whose
files exist are skipped. Run from repo root: python3 scripts/repair_icons.py
"""
import gzip
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import zipfile
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_db as b  # noqa: E402

REF_DIR = os.path.join(b.ROOT, "dev-data", "ref")
IMG_DIR = os.path.join(REF_DIR, "img")
DB_PATH = os.path.join(REF_DIR, "reference.db")
GZ_PATH = os.path.join(REF_DIR, "reference.v1.db.gz")

GIFT_CATS = {
    "Housewares", "Miscellaneous", "Wall-mounted", "Ceiling Decor",
    "Interior Structures",
    "Tops", "Bottoms", "Dress-Up", "Headwear", "Accessories",
    "Socks", "Shoes", "Bags", "Umbrellas", "Clothing Other",
}


def main() -> int:
    db = sqlite3.connect(DB_PATH)
    ph = ",".join("?" * len(GIFT_CATS))

    # --- 1. audit: rows absent from images, and rows whose file is gone ----
    holes = []  # (category, name, variation, existing_url_or_'')
    have = set()
    for cat, name, var in db.execute(
        f"SELECT DISTINCT category, name, variation FROM items "
        f"WHERE category IN ({ph}) ORDER BY category, name, variation",
        list(GIFT_CATS),
    ):
        row = db.execute(
            "SELECT url FROM images WHERE category=? AND lower(name)=lower(?) "
            "AND lower(variation)=lower(?)",
            (cat, name, var),
        ).fetchone()
        if row is None:
            holes.append((cat, name, var, ""))
        else:
            url = row[0] or ""
            rel = url.removeprefix("/img/")
            if not os.path.exists(os.path.join(IMG_DIR, rel)):
                holes.append((cat, name, var, url))
            else:
                have.add((cat, name.lower(), (var or "").lower()))
    print(f"audit: {len(holes)} holes, {len(have)} healthy")

    if holes:
        # --- 2. resolve -----------------------------------------------------
        manifest = json.load(open(os.path.join(IMG_DIR, "manifest.json")))
        urls = set(manifest["urls"])

        def fix(t):
            cat, name, var, old_url = t
            # xlsx 'NA' means NO variation: resolve the base icon, but keep
            # the table's literal-'NA' row + '_na' URL-stem convention.
            eff_var = "" if (var or "").strip().lower() in ("", "na", "none") \
                else var
            _, data = b.registry_icon_for(name, eff_var)
            if not data:
                u = b.wiki_pageimages(b.titlecase(name))
                if u:
                    try:
                        data = b.http_get(u)
                    except Exception:
                        data = None
            if not data:
                try:
                    data = b.wiki_gallery(b.titlecase(name))
                except Exception:
                    data = None
            if not data:
                return None
            stem = b.sanitize_filename(name)
            if var:
                stem += "_" + b.sanitize_filename(var)
            url = b.save_image(IMG_DIR, cat, stem, data)
            return (cat, name, var, url)

        fixed = []
        with ThreadPoolExecutor(max_workers=12) as pool:
            for res in pool.map(fix, holes):
                if res is None:
                    continue
                fixed.append(res)

        for cat, name, var, url in fixed:
            db.execute(
                "INSERT OR REPLACE INTO images VALUES (?,?,?,?)",
                (cat, name, var, url),
            )
            urls.add(url)
        db.commit()
        print(f"fixed {len(fixed)}, unresolved {len(holes) - len(fixed)}")
        if len(fixed) < len(holes):
            still = sorted({(c, n, v) for c, n, v, _ in holes}
                           - {(c, n, v) for c, n, v, _ in fixed})
            miss_path = os.path.join(b.ROOT, "repair-icons-still-missing.txt")
            with open(miss_path, "w") as f:
                for c, n, v in still:
                    f.write(f"{c}\t{n}\t{v}\n")
            print(f"    remaining -> {os.path.basename(miss_path)}")
        if not fixed:
            return 1

        # --- 4. zip + manifest ----------------------------------------------
        urls = sorted(urls)
        image_hash = hashlib.sha256("\n".join(urls).encode()).hexdigest()
        zip_path = os.path.join(IMG_DIR, "images.zip")
        zip_tmp = zip_path + ".tmp"
        total_bytes = 0
        with zipfile.ZipFile(zip_tmp, "w", zipfile.ZIP_STORED,
                             allowZip64=True) as zf:
            for root, _, files in os.walk(IMG_DIR):
                for fn in files:
                    if not fn.endswith(".webp"):
                        continue
                    full = os.path.join(root, fn)
                    zf.write(full, os.path.relpath(full, IMG_DIR))
                    total_bytes += os.path.getsize(full)
        os.replace(zip_tmp, zip_path)
        man_tmp = os.path.join(IMG_DIR, "manifest.json.tmp")
        with open(man_tmp, "w") as f:
            json.dump({"hash": image_hash, "count": len(urls), "urls": urls,
                       "zipSize": os.path.getsize(zip_path),
                       "totalBytes": total_bytes,
                       "zipName": "images.zip"}, f)
        os.replace(man_tmp, os.path.join(IMG_DIR, "manifest.json"))
        print(f"manifest: {len(urls)} urls, hash={image_hash[:12]}…")

        # --- 5. meta hash + VACUUM + regzip ---------------------------------
        db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)",
                   ("image_hash", image_hash))
        db.commit()
        db.execute("VACUUM")
        gz_tmp = GZ_PATH + ".tmp"
        with open(DB_PATH, "rb") as fin, \
                gzip.open(gz_tmp, "wb", compresslevel=9) as fout:
            shutil.copyfileobj(fin, fout)
        os.replace(gz_tmp, GZ_PATH)
        print(f"regzipped -> {GZ_PATH} ({os.path.getsize(GZ_PATH)/1e6:.1f} MB)")
    db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
