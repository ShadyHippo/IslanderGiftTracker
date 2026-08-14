#!/usr/bin/env python3
"""Build the ACNH reference database (master: all data + all images).

Python stdlib only. Steps:
  1. Parse the xlsx (zip + ElementTree; no pip deps).
  2. Create reference.db: one table per sheet + items (flattened) + images + meta.
  3. Fetch every available image from dodo.ac (Nookipedia CDN) into the images table.
  4. Gzip to reference.vN.db.gz. Print sizes + per-category hit-rate.

Usage:
  python3 scripts/build_db.py            # full build
  python3 scripts/build_db.py --limit 5  # only 5 images per category (sanity check)
  python3 scripts/build_db.py --categories villagers   # only listed categories, no limit
  python3 scripts/build_db.py --no-images
"""
import gzip
import hashlib
import json
import os
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from xml.etree import ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
XLSX = os.path.join(ROOT, "res", "Data Spreadsheet for Animal Crossing New Horizons.xlsx")
OUT_DB = os.path.join(ROOT, "reference.db")
OUT_GZ = os.path.join(ROOT, "reference.v1.db.gz")
CACHE_DIR = os.path.join(ROOT, "cache")
IMAGES_RAW = os.path.join(ROOT, "images", "raw")
IMAGES_THUMB = os.path.join(ROOT, "images", "thumb")
thumb = 0
MISSED_LOG = os.path.join(ROOT, "images-missed.txt")
DB_VERSION = 1

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
HDR = {"User-Agent": UA}

# sheets whose 1st column is "#" (Name is the 2nd)
NAME_COL_TWO = {"Insects", "Fish", "Sea Creatures", "Reactions"}
# sheets with no images to fetch (nothing exists on the wiki for them)
NO_IMAGE_SHEETS = {"Read Me", "Seasons and Events", "Paradise Planning"}

# column names captured into the flattened `items` table
ITEM_COLS = {"Name", "Variation", "Style", "Color 1", "Color 2", "Buy", "Sell", "Source"}

# filename pattern priority per category (title-cased name substituted for {n})
PATTERNS = {
    "Villagers":      ["{n}_NH_Villager_Icon.png", "{n}_NH_Icon.png", "{n}_NH_Texture.png", "{n}_NH.png"],
    "Special NPCs":   ["{n}_NH_Villager_Icon.png", "{n}_NH_Icon.png", "{n}_NH_Texture.png", "{n}_NH.png"],
    "Music":          ["{n}_NH_Texture.png", "{n}_NH_Icon.png", "{n}_NH.png"],
    "Artwork":        ["{n}_NH_Icon.png", "{n}_NH_Texture.png", "{n}_NH.png"],
    "Photos":         ["{n}_NH_Icon.png", "{n}_NH_Texture.png", "{n}_NH.png"],
    "Posters":        ["{n}_NH_Icon.png", "{n}_NH_Texture.png", "{n}_NH.png"],
    "default":        ["{n}_NH_Icon.png", "{n}_NH_Texture.png", "{n}_NH.png"],
}
THUMB_SIZE = 128
THUMB_BYTES_TRIGGER = 150_000  # if full image is larger, try 128px thumb


def downscale_png(data, px):
    """Shrink a PNG to at most px px on the long side using ImageMagick.
    Returns downscaled bytes, or the original if convert fails."""
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".png") as fin, \
         tempfile.NamedTemporaryFile(suffix=".png") as fout:
        fin.write(data)
        fin.flush()
        r = subprocess.run(["convert", fin.name, "-resize", f"{px}x{px}>",
                            "-strip", fout.name], capture_output=True)
        if r.returncode != 0:
            return data
        with open(fout.name, "rb") as f:
            return f.read()


def maybe_thumb(fn, data):
    """Downscale with a disk cache (cache/thumb{px}/{fn}): repeated rebuilds
    of the same images skip ImageMagick entirely."""
    if not thumb:
        return data
    for d in (IMAGES_THUMB, os.path.join(CACHE_DIR, f"thumb{thumb}")):
        p = os.path.join(d, fn)
        if os.path.exists(p):
            with open(p, "rb") as f:
                return f.read()
    p = os.path.join(IMAGES_THUMB, fn)
    t = downscale_png(data, thumb)
    if t:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(t)
    return t
    return data


# ---------------------------------------------------------------- xlsx parsing

def load_workbook():
    z = zipfile.ZipFile(XLSX)
    ss_root = ET.fromstring(z.read("xl/sharedStrings.xml").decode("utf-8"))
    shared = [''.join(t.text or '' for t in si.iter(NS + 't')) or '' for si in ss_root]
    wb = ET.fromstring(z.read("xl/workbook.xml").decode("utf-8"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels").decode("utf-8"))
    rid2target = {r.attrib['Id']: r.attrib['Target'] for r in rels}
    rid_attr = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
    sheets = [(s.attrib['name'], rid2target[s.attrib[rid_attr]]) for s in wb.iter(NS + 'sheet')]

    def cell_val(c):
        t = c.attrib.get('t')
        v = c.find(NS + 'v')
        if v is None or v.text is None:
            return ''
        if t == 's':
            return shared[int(v.text)]
        return v.text

    out = {}
    for name, target in sheets:
        path = "xl/" + target.replace("../", "")
        if name in NO_IMAGE_SHEETS:
            continue
        sh = ET.fromstring(z.read(path).decode("utf-8"))
        rows = []
        for r in sh.iter(NS + 'row'):
            cells = r.findall(NS + 'c')
            if not cells:
                continue
            vals = [cell_val(c) for c in cells]
            rows.append(vals)
        if not rows:
            continue
        out[name] = rows
    return z, out


def snake(s):
    return (s.lower().replace(' ', '_').replace('-', '_').replace("'", "")
            .replace('&', 'and').replace('?', '').replace('/', '_'))


# ---------------------------------------------------------------- image fetch

def titlecase(s):
    out = []
    for w in s.split():
        if w.lower() == "k.k.":
            out.append("K.K.")
        else:
            out.append(w[0].upper() + w[1:])
    return ' '.join(out)


def titlecase_hyphen(s):
    """Capitalize each hyphen segment too: 'bamboo-slats' -> 'Bamboo-Slats'."""
    def cap(w):
        return '-'.join(p[0].upper() + p[1:] for p in w.split('-'))
    return ' '.join("K.K." if w.lower() == "k.k." else cap(w) for w in s.split())


def dodo_url(fname):
    h = hashlib.md5(fname.encode()).hexdigest()
    return (f"https://dodo.ac/np/images/{h[0]}/{h[:2]}/"
            + urllib.parse.quote(fname))


def dodo_thumb_url(fname):
    h = hashlib.md5(fname.encode()).hexdigest()
    return (f"https://dodo.ac/np/images/thumb/{h[0]}/{h[:2]}/{urllib.parse.quote(fname)}/"
            f"{THUMB_SIZE}px-{urllib.parse.quote(fname)}")


def http_get(url, timeout=15):
    req = urllib.request.Request(url, headers=HDR)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def try_fetch(fname):
    """Fetch fname (full, then thumb if big). Returns bytes or None."""
    for url in (dodo_url(fname),):
        try:
            data = http_get(url)
            if len(data) > THUMB_BYTES_TRIGGER:
                try:
                    t = http_get(dodo_thumb_url(fname))
                    if t:
                        data = t
                except Exception:
                    pass
            return data
        except Exception:
            # Any upstream error (404, 500, timeout) counts as a miss; a flaky
            # dodo.ac must not kill the whole build.
            return None
    return None


def fetch_image_bytes(fname, cache_dir):
    """Fetch fname from dodo.ac (disk-cached). Returns bytes or None."""
    p = os.path.join(cache_dir, fname)
    if os.path.exists(p):
        with open(p, "rb") as f:
            return f.read()
    data = try_fetch(fname)
    if data:
        with open(p, "wb") as f:
            f.write(data)
    return data


def wiki_pageimages(title):
    """MediaWiki API fallback: pageimages thumbnail. Returns url or None."""
    q = {"action": "query", "format": "json", "redirects": "1",
         "prop": "pageimages", "piprop": "thumbnail", "pithumbsize": str(THUMB_SIZE),
         "titles": title}
    url = "https://nookipedia.com/w/api.php?" + urllib.parse.urlencode(q)
    try:
        d = json.loads(http_get(url).decode())
    except Exception:
        return None
    for p in d.get("query", {}).get("pages", {}).values():
        th = p.get("thumbnail", {})
        src = th.get("source")
        if src:
            return src
    return None


def wiki_gallery(title):
    """MediaWiki API fallback: images on the {title}/Gallery subpage. Returns url or None."""
    q = {"action": "query", "format": "json", "redirects": "1", "generator": "images",
         "titles": title + "/Gallery", "gimlimit": "100",
         "prop": "imageinfo", "iiprop": "url"}
    url = "https://nookipedia.com/w/api.php?" + urllib.parse.urlencode(q)
    try:
        d = json.loads(http_get(url).decode())
    except Exception:
        return None
    imgs = []
    for p in d.get("query", {}).get("pages", {}).values():
        imgs.append(p.get("title", ""))
    for im in imgs:
        if "_NH_" in im and ("Icon" in im or "Texture" in im or im.endswith("_NH.png")):
            u = dodo_url(im)
            try:
                return http_get(u)
            except Exception:
                continue
    return None


def wiki_allimages(title):
    """Best fallback: search the image registry for exact filenames.
    Returns the first NH icon matching the prefix, downloaded, or None."""
    q = {"action": "query", "format": "json", "list": "allimages",
         "aiprefix": title.replace(' ', '_'), "ailimit": "50"}
    url = "https://nookipedia.com/w/api.php?" + urllib.parse.urlencode(q)
    try:
        d = json.loads(http_get(url).decode())
    except Exception:
        return None
    names = [i["name"] for i in d.get("query", {}).get("allimages", [])]
    ordered = ([n for n in names if "_NH_" in n and "Icon" in n] +
               [n for n in names if "_NH_" in n and "Texture" in n] +
               [n for n in names if "_NH_" in n])
    for fn in dict.fromkeys(ordered):
        try:
            return http_get(dodo_url(fn))
        except Exception:
            continue
    return None


# ---------------------------------------------------------------- build

def main():
    global OUT_DB, OUT_GZ, thumb
    args = sys.argv[1:]
    limit = None
    no_images = "--no-images" in args
    categories = None
    thumb = 0
    for i, a in enumerate(args):
        if a == "--limit":
            limit = int(args[i + 1])
        if a == "--thumb":
            thumb = int(args[i + 1])
        if a == "--categories":
            categories = set(c.strip() for c in args[i + 1].split(",") if c.strip())
        if a == "--out-dir":
            OUT_DB = os.path.join(args[i + 1], "reference.db")
            OUT_GZ = os.path.join(args[i + 1], "reference.v1.db.gz")
    if OUT_DB and OUT_GZ:
        os.makedirs(os.path.dirname(OUT_DB), exist_ok=True)

    print(f"[1/4] parsing {os.path.basename(XLSX)} ...")
    z, sheets = load_workbook()
    z.close()

    # Build atomically: write to .tmp files and rename into place only at the
    # very end, so a crash or a running rebuild never leaves a half-written
    # reference db (and never blanks the served .gz that clients are using).
    out_db_tmp = OUT_DB + ".tmp"
    out_gz_tmp = OUT_GZ + ".tmp"
    if os.path.exists(out_db_tmp):
        os.remove(out_db_tmp)
    db = sqlite3.connect(out_db_tmp)
    db.execute("PRAGMA journal_mode=OFF")
    db.execute("PRAGMA synchronous=OFF")

    print("[2/4] creating tables ...")
    db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    db.execute("INSERT INTO meta VALUES ('schema_version', ?), ('build_date', ?)",
               (str(DB_VERSION), __import__("datetime").date.today().isoformat()))
    db.execute("CREATE TABLE items (name TEXT, category TEXT, variation TEXT, style TEXT,"
               " color1 TEXT, color2 TEXT, buy TEXT, sell TEXT, source TEXT, label_themes TEXT,"
               " type_path TEXT)")
    db.execute("CREATE TABLE images (category TEXT, name TEXT, variation TEXT, data BLOB,"
               " url TEXT, PRIMARY KEY (category, name, variation))")

    sheet_tables = {}
    for sheet_name, rows in sheets.items():
        header = rows[0]
        tname = snake(sheet_name)
        cols = [snake(h) if h else f"col{i}" for i, h in enumerate(header)]
        db.execute(f"CREATE TABLE {tname} ({', '.join(f'\"{c}\" TEXT' for c in cols)})")
        ins = f"INSERT INTO {tname} VALUES ({','.join('?' * len(cols))})"
        for row in rows[1:]:
            if not any(row):
                continue
            db.execute(ins, row + [''] * (len(cols) - len(row)))
        sheet_tables[sheet_name] = tname
        print(f"    {sheet_name}: {len(rows)-1} rows -> {tname}")

    # flattened items table
    print("[2b/4] flattening items ...")
    n_items = 0
    for sheet_name, rows in sheets.items():
        header = rows[0]
        idx = {h: i for i, h in enumerate(header) if h}
        have = {"Name", "Color 1", "Color 2"}.intersection(idx)
        if not have:
            continue
        def g(row, col):
            i = idx.get(col)
            return row[i] if i is not None and i < len(row) else ''
        # Clothing sheets carry 'Style 1'/'Style 2' (not 'Style'); merge into one
        # column so the client matcher can compare against villager styles.
        # Furniture sheets carry a cataloged type path (e.g. 'Kitchen/Appliance/Fridge');
        # see scripts/furniture_types.py — regenerated every build.
        from furniture_types import classify, FURNITURE_CATEGORIES
        for row in rows[1:]:
            if not row or not row[idx.get("Name", 0) if "Name" in idx else 0]:
                continue
            style = '; '.join(x for x in (g(row, 'Style 1'), g(row, 'Style 2')) if x) or g(row, 'Style')
            tpath = '/'.join(classify(g(row, "Name"))) if sheet_name in FURNITURE_CATEGORIES else ''
            db.execute("INSERT INTO items VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                       (g(row, "Name"), sheet_name, g(row, "Variation"), style,
                        g(row, "Color 1"), g(row, "Color 2"), g(row, "Buy"),
                        g(row, "Sell"), g(row, "Source"), g(row, "Label Themes"), tpath))
            n_items += 1
    print(f"    items: {n_items} rows")

    # images
    if not no_images:
        print("[3/4] fetching images ...")
        for d in (CACHE_DIR, IMAGES_RAW, IMAGES_THUMB):
            os.makedirs(d, exist_ok=True)
        # cached bytes are read lazily per filename in one() via get_cache_bytes
        tasks = []
        for sheet_name, rows in sheets.items():
            if sheet_name in NO_IMAGE_SHEETS:
                continue
            header = rows[0]
            vi = header.index("Variation") if "Variation" in header else -1
            name_col = 1 if sheet_name in NAME_COL_TWO else 0
            seen = set()
            for row in rows[1:]:
                if name_col >= len(row) or not row[name_col]:
                    continue
                var = row[vi] if vi >= 0 and vi < len(row) else ''
                key = (row[name_col], var)
                if key in seen:
                    continue
                seen.add(key)
                tasks.append((sheet_name, row[name_col], var))
        if categories:
            wanted = {c.lower() for c in categories}
            tasks = [t for t in tasks if t[0].lower() in wanted]
        print(f"    {len(tasks)} (name, variation) pairs to fetch")
        if limit:
            seen_cat = {}
            tasks = [t for t in tasks
                     if seen_cat.setdefault(t[0], 0) < limit and not seen_cat.__setitem__(t[0], seen_cat[t[0]] + 1)]

        def get_cache_bytes(fn):
            for d in (IMAGES_RAW, CACHE_DIR):
                p = os.path.join(d, fn)
                if os.path.exists(p):
                    with open(p, "rb") as f:
                        return f.read()
            return None

        stats = {s: [0, 0] for s, _, _ in tasks}  # hits, total
        misses = []
        n_done = 0
        print(f"    {len(tasks)} unique items to fetch")

        def one(task):
            cat, name, var = task
            bases = [titlecase(name).replace(' ', '_'),
                     titlecase_hyphen(name).replace(' ', '_')]
            pats = PATTERNS.get(cat, PATTERNS["default"])
            vpats = (["{n}_({v})_NH_Icon.png", "{n}_({v})_NH_Texture.png", "{n}_({v})_NH.png"]
                     if var else [])
            for base in dict.fromkeys(bases):
                for pat in pats:
                    fn = pat.format(n=base)
                    data = get_cache_bytes(fn)
                    if data is None:
                        data = try_fetch(fn)
                        if data:
                            with open(os.path.join(CACHE_DIR, fn), "wb") as f:
                                f.write(data)
                    if data:
                        data = maybe_thumb(fn, data)
                    if data:
                        return cat, name, var, fn, data
            if vpats:
                v = titlecase(var).replace(' ', '_')
                for base in dict.fromkeys(bases):
                    for pat in vpats:
                        fn = pat.format(n=base, v=v)
                        data = get_cache_bytes(fn)
                        if data is None:
                            data = try_fetch(fn)
                            if data:
                                with open(os.path.join(IMAGES_RAW, fn), "wb") as f:
                                    f.write(data)
                        if data:
                            data = maybe_thumb(fn, data)
                        if data:
                            return cat, name, var, fn, data
            data = (wiki_allimages(name) or wiki_pageimages(name) or wiki_gallery(name))
            if data:
                if isinstance(data, str):  # url from pageimages
                    try:
                        data = http_get(data)
                    except Exception:
                        return cat, name, var, None, None
                if data:
                    wfn = f"wiki_{name}_{var}".replace(' ', '_') + ".png"
                    with open(os.path.join(IMAGES_RAW, wfn), "wb") as f:
                        f.write(data)
                    data = maybe_thumb(wfn, data)
                return cat, name, var, wfn, data
            return cat, name, var, None, None

        with ThreadPoolExecutor(max_workers=16) as pool:
            for cat, name, var, fn, data in pool.map(one, tasks):
                stats[cat][1] += 1
                if data:
                    stats[cat][0] += 1
                    db.execute("INSERT OR REPLACE INTO images VALUES (?,?,?,?,?)",
                               (cat, name, var, sqlite3.Binary(data), fn))
                else:
                    misses.append((cat, name, var))
                n_done += 1
                if n_done % 500 == 0:
                    print(f"    {n_done}/{len(tasks)} images processed")

        db.commit()
        print("\n    per-category hit-rate:")
        for cat, (hit, total) in sorted(stats.items()):
            print(f"      {cat:22s} {hit:5d}/{total}  ({100*hit//max(total,1)}%)")
        if misses:
            with open(MISSED_LOG, "w") as f:
                for cat, name, var in sorted(misses):
                    f.write(f"{cat}\t{name}\t{var}\n")
            print(f"    misses: {len(misses)} -> {os.path.basename(MISSED_LOG)}")
    else:
        print("[3/4] skipping images (--no-images)")

    print(f"[4/4] writing db + gz ...")
    db.commit()
    db.close()
    raw = os.path.getsize(out_db_tmp)
    with open(out_db_tmp, "rb") as fin, gzip.open(out_gz_tmp, "wb", compresslevel=9) as fout:
        import shutil
        shutil.copyfileobj(fin, fout)
    gz = os.path.getsize(out_gz_tmp)
    # Atomic swap: the served files are replaced only once both are complete.
    os.replace(out_db_tmp, OUT_DB)
    os.replace(out_gz_tmp, OUT_GZ)
    print(f"\nDone.")
    print(f"  reference.db       : {raw/1e6:.1f} MB")
    print(f"  reference.v1.db.gz : {gz/1e6:.1f} MB")
    if thumb:
        print(f"  (images downscaled to max {thumb}px)")


if __name__ == "__main__":
    main()
