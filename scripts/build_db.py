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
import html as _html
import json
import os
import re
import unicodedata
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


def sanitize_filename(s):
    """Lowercase, strip accents + non-ASCII, spaces->underscores, special chars."""
    s = _html.unescape(str(s))
    # Map symbolic chars to words before stripping non-ASCII
    s = s.replace('←', 'left').replace('→', 'right')
    # Decompose accented chars (e → e + ´) then drop combining marks
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii')
    s = s.lower().replace(' ', '_').replace('-', '_')
    s = re.sub(r'[^\w.]', '', s)
    s = re.sub(r'_+', '_', s).strip('_.')
    return s

def strip_accents(s):
    """Remove diacritics so 'Viché'/'Renée' match 'Viche'/'Renee'."""
    return unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii')


NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
HDR = {"User-Agent": UA}

# sheets whose 1st column is "#" (Name is the 2nd)
NAME_COL_TWO = {"Insects", "Fish", "Sea Creatures", "Reactions"}
# sheets with no images to fetch (nothing exists on the wiki for them)
NO_IMAGE_SHEETS = {"Read Me", "Seasons and Events", "Paradise Planning"}

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


# WebP is what the client downloads (half the first-load size, visually
# identical at q90). The original PNG is still written to disk as the pristine
# reference so a webp bug can always be reverted.
WEBP_QUALITY = 90


def to_webp(png_path, webp_path):
    """Convert a PNG file to WebP. Tries ImageMagick, then cwebp. Raises if
    both are unavailable or fail — a broken webp pipeline must fail the build,
    never silently serve PNGs."""
    import subprocess
    r = subprocess.run(["convert", png_path, "-quality", str(WEBP_QUALITY),
                        "-strip", webp_path], capture_output=True)
    if r.returncode == 0 and os.path.exists(webp_path):
        return True
    r = subprocess.run(["cwebp", "-quiet", "-q", str(WEBP_QUALITY),
                        png_path, "-o", webp_path], capture_output=True)
    if r.returncode == 0 and os.path.exists(webp_path):
        return True
    raise RuntimeError(
        f"webp conversion failed for {png_path} "
        f"(convert: {r.returncode}, cwebp: {r.returncode}) — "
        "is imagemagick/webp installed in the build image?"
    )


def save_image(img_dir, cat, stem, data, image_urls=None):
    """Write image bytes as PNG (pristine) + WebP (served). Returns the served
    /img/...webp URL. Raises on conversion failure — never falls back to PNG."""
    rel = os.path.join(sanitize_filename(cat), sanitize_filename(stem))
    png_path = os.path.join(img_dir, rel + '.png')
    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    with open(png_path, 'wb') as f:
        f.write(data)
    to_webp(png_path, os.path.join(img_dir, rel + '.webp'))
    url = f'/img/{rel}.webp'
    if image_urls is not None:
        image_urls.append(url)
    return url


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


# ---------------------------------------------------------------- house data
# Per-villager house furniture + colors come from Nookipedia's nh_house Cargo
# table (https://nookipedia.com/wiki/Nookipedia:Cargo_tables). Each villager
# row stores the house items as JSON; the image filename encodes the exact
# variation ("Tea_Set_(Red_-_Red)_NH_Icon.png"), which we resolve against the
# xlsx items table to get the *specific* colors of that villager's house.

NH_HOUSE_CACHE = os.path.join(CACHE_DIR, "nh_house.json")
HOUSE_IMG_CACHE = os.path.join(CACHE_DIR, "house")

def fetch_nh_house():
    """Cargo query for all villager house rows (name_sort + items JSON + photos).
    Cached to cache/nh_house.json so rebuilds skip the network call."""
    if os.path.exists(NH_HOUSE_CACHE):
        with open(NH_HOUSE_CACHE) as f:
            return json.load(f)
    q = {"action": "cargoquery", "tables": "nh_house", "format": "json", "limit": "500",
         "fields": "name_sort,items,interior_image_url,exterior_image_url"}
    url = "https://nookipedia.com/w/api.php?" + urllib.parse.urlencode(q)
    d = json.loads(http_get(url, timeout=30).decode())
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(NH_HOUSE_CACHE, "w") as f:
        json.dump(d, f)
    return d


def house_variation_from_url(url):
    """Extract the exact variation from a Nookipedia item image URL:
    '.../Tea_Set_%28Red_-_Red%29_NH_Icon.png' -> 'Red - Red'
    '.../Cute_Sofa_NH_Icon.png' -> '' (base). Takes the LAST parenthesized
    group so sizes like '(50 in.)' before the color are ignored."""
    if not url:
        return ''
    fn = urllib.parse.unquote(url.split('/')[-1])
    groups = re.findall(r'\(([^)]+)\)', fn)
    if not groups:
        return ''
    return groups[-1].replace('_', ' ').strip()


def build_variant_lookup(sheets):
    """norm_name -> list of {var, pat, vid, c1, c2, name} from the xlsx sheets."""
    norm = lambda s: re.sub(r'[\s-]+', ' ', str(s).strip().lower())
    out = {}
    for sheet_name, rows in sheets.items():
        header = rows[0]
        idx = {h: i for i, h in enumerate(header) if h}
        if not {"Name", "Color 1", "Color 2"}.issubset(idx):
            continue
        def g(row, col):
            i = idx.get(col)
            return row[i] if i is not None and i < len(row) else ''
        for row in rows[1:]:
            nm = norm(g(row, "Name"))
            if not nm:
                continue
            out.setdefault(nm, []).append({
                "var": norm(g(row, "Variation")),
                "var_raw": g(row, "Variation"),
                "pat": norm(g(row, "Pattern")),
                "vid": str(g(row, "Variant ID") or '').strip(),
                "c1": g(row, "Color 1"), "c2": g(row, "Color 2"),
                "name": g(row, "Name"), "category": sheet_name,
            })
    return out


def resolve_house_variant(opts, variation):
    """Map a Nookipedia variation string to the exact xlsx variant row.
    variation == '' means the item's base variant (Variant ID 0_*)."""
    if not opts:
        return None
    v = variation.strip().lower()
    if not v:
        for o in opts:
            if o["vid"].startswith("0_") and o["pat"] in ("", "na"):
                return o
        for o in opts:
            if o["vid"].startswith("0_"):
                return o
        for o in opts:
            if o["pat"] in ("", "na"):
                return o
        return opts[0]
    # "Body - Pattern" (e.g. 'Red - Red'): split first, then normalize each part
    # (normalizing first would collapse the separator into a space).
    if ' - ' in v:
        body, pat = v.split(' - ', 1)
        body = re.sub(r'[\s-]+', ' ', body)
        pat = re.sub(r'[\s-]+', ' ', pat)
        for o in opts:
            if o["var"] == body and o["pat"] == pat:
                return o
    vn = re.sub(r'[\s-]+', ' ', v)
    for o in opts:
        if o["var"] == vn and o["pat"] in ("", "na"):
            return o
    for o in opts:
        if o["pat"] == vn:
            return o
    for o in opts:
        if o["var"] == vn:
            return o
    return opts[0]


def cached_house_image(url, key):
    """Fetch a full-quality house photo (interior/exterior), disk-cached by key."""
    os.makedirs(HOUSE_IMG_CACHE, exist_ok=True)
    p = os.path.join(HOUSE_IMG_CACHE, key)
    if os.path.exists(p):
        with open(p, "rb") as f:
            return f.read()
    data = http_get(url, timeout=30)
    if data:
        with open(p, "wb") as f:
            f.write(data)
    return data


def cached_item_icon(url):
    """Fetch a small Nookipedia NH_Icon.png (exact variation icon), disk-cached.
    Shares the house image cache dir; files end in .png so they never collide
    with the interior/exterior photo keys ('.img')."""
    if not url:
        return None
    key = urllib.parse.unquote(url.split('/')[-1])
    p = os.path.join(HOUSE_IMG_CACHE, key)
    if os.path.exists(p):
        with open(p, "rb") as f:
            return f.read()
    data = http_get(url, timeout=30)
    if data:
        with open(p, "wb") as f:
            f.write(data)
    return data


def _cache_bytes(fn):
    """Return cached bytes for a Nookipedia filename, or None."""
    for d in (IMAGES_RAW, CACHE_DIR, HOUSE_IMG_CACHE):
        p = os.path.join(d, fn)
        if os.path.exists(p):
            with open(p, "rb") as f:
                return f.read()
    return None


def fetch_variant_icon(name, variation):
    """Fetch the exact Nookipedia NH_Icon for name + variation (e.g.
    'ranch bed' + 'Green - Blue gingham'). This is used for house items whose
    exact variant the images stage can't produce (it only walks the xlsx
    'Variation' body column). Returns (filename, bytes) or (None, None).
    Disk-cached; safe to call mid-build. Falls back to the MediaWiki image
    registry to match Nookipedia's exact filenames (e.g. 'Wall_Shelf_with_
    Bottles', 'Bottle_Crate_(Yellow_-_Apple)')."""
    if not variation:
        return None, None
    v = titlecase(variation).replace(' ', '_')
    # Some xlsx variations end in a redundant 'None'/'null'/'NA' color segment
    # that Nookipedia's filename omits (e.g. 'Black - None' -> '(Black)').
    import re as _re
    stripped = _re.sub(r'\s*-\s*(None|null|NA|N\/A)$', '', variation).strip()
    vs = dict.fromkeys([v] + ([titlecase(stripped).replace(' ', '_')] if stripped and stripped != variation else []))
    bases = [titlecase(name).replace(' ', '_'),
             titlecase_hyphen(name).replace(' ', '_'),
             name.replace(' ', '_')]
    pats = ["{n}_({v})_NH_Icon.png", "{n}_({v})_NH_Texture.png", "{n}_({v})_NH.png"]
    for base in dict.fromkeys(bases):
        for vv in vs:
            for pat in pats:
                fn = pat.format(n=base, v=vv)
                data = _cache_bytes(fn)
                if data is None:
                    data = try_fetch(fn)
                    if data:
                        with open(os.path.join(CACHE_DIR, fn), "wb") as f:
                            f.write(data)
                if data:
                    return fn, maybe_thumb(fn, data)
    # Registry fallback: Nookipedia filenames keep their own casing/stopwords
    # (e.g. 'Wall_Shelf_with_Bottles', 'Wall-Mounted_TV'), so guessed prefixes
    # can 404. Search the MediaWiki image registry with a best-effort base and
    # match by token containment, then by variation containment.
    import re as _re
    want_v = _re.sub(r'\s+', ' ', variation).strip()
    want_v = _re.sub(r'^NA\s*-\s*', '', want_v).lower()
    want_tokens = set(_re.findall(r"[a-z0-9]+", want_v)) - {"none"}
    name_tokens = set(_re.findall(r"[a-z0-9]+", name.lower()))
    probes = list(dict.fromkeys(
        [b for b in bases] +
        [titlecase(name.split()[0]).replace(' ', '_'),
         titlecase_hyphen(name.split()[0]).replace(' ', '_')] if name.split() else []
    ))
    for base in probes:
        names = _wiki_allimages_filenames(base)
        for fn in names:
            if '_NH_' not in fn:
                continue
            m = _re.search(r'\((.*)\)_NH_', fn)
            pre_nh = fn.split('_NH_', 1)[0]
            tail = _re.search(r'\(([^()]*)\)$', pre_nh)
            base_part = pre_nh[:tail.start()] if tail else pre_nh
            fn_tokens = set(_re.findall(r"[a-z0-9]+", base_part.lower()))
            if not (name_tokens <= fn_tokens):
                continue
            file_v = _re.sub(r'\s+', ' ', m.group(1)).strip().lower() if m else ''
            if (want_tokens and want_tokens <= set(_re.findall(r"[a-z0-9]+", file_v))) or \
               (not want_tokens and _re.sub(r'[^a-z0-9]', '', want_v) == _re.sub(r'[^a-z0-9]', '', file_v)):
                data = _cache_bytes(fn)
                if data is None:
                    data = try_fetch(fn)
                    if data:
                        with open(os.path.join(CACHE_DIR, fn), "wb") as f:
                            f.write(data)
                if data:
                    return fn, maybe_thumb(fn, data)
    return None, None


def _wiki_allimages_filenames(prefix):
    """Return the list of Nookipedia image filenames whose title starts with
    prefix (cached per-prefix to avoid hammering the API mid-build). The cache
    read is guarded and writes are atomic: repair/build workers share these
    files, so a torn read must refetch instead of poisoning the run."""
    import time
    key = "allimages_" + prefix
    p = os.path.join(CACHE_DIR, key + ".json")
    if os.path.exists(p):
        try:
            with open(p) as f:
                return json.load(f)
        except Exception:
            pass  # corrupt/torn entry — fall through and refetch
    q = {"action": "query", "format": "json", "list": "allimages",
         "aiprefix": prefix, "ailimit": "500"}
    url = "https://nookipedia.com/w/api.php?" + urllib.parse.urlencode(q)
    names = []
    ok = False
    for attempt in range(3):
        try:
            d = json.loads(http_get(url).decode())
            names = [i["name"] for i in d.get("query", {}).get("allimages", [])]
            ok = True
            break
        except Exception:
            if attempt == 2:
                names = []
            else:
                time.sleep(2 * (attempt + 1))
    if not ok:
        return names  # never cache failures — an empty list would poison
                      # every future run of this prefix
    try:
        with open(p + ".tmp", "w") as f:
            json.dump(names, f)
        os.replace(p + ".tmp", p)
    except Exception:
        pass
    return names


def registry_icon_for(name, variation=''):
    """Resolve an item icon through the MediaWiki image registry when direct
    filename guesses fail. Two Nookipedia quirks force this: (1) filenames
    capitalize differently than titlecase guesses ('Cream_and_Sugar', not
    'Cream_And_Sugar') and MediaWiki aiprefix matching is case-sensitive after
    the first character — solved by probing progressively shorter prefixes
    (full name, then first word alone); (2) wiki icons often carry an extra
    parenthesized qualifier beyond the xlsx variation ('Baby_Bed_(Blue_-_
    Plain_White)' for xlsx 'White') — solved by token-containment matching.
    Candidates are scored so an exact base-name match beats a superset one.
    Disk-cached; safe to call mid-build. Returns (filename, bytes) or (None,
    None)."""
    import re as _re
    want_v = _re.sub(r'\s+', ' ', variation or '').strip()
    want_v = _re.sub(r'^NA\s*-\s*', '', want_v).lower()
    # xlsx colors sports-tank colorways '1.0'..'8.0'; wiki calls them '(3)'.
    m_ver = _re.fullmatch(r"(\d+)\.0", want_v)
    if m_ver:
        want_v = m_ver.group(1)
    want_tokens = set(_re.findall(r"[a-z0-9]+", want_v)) - {"none"}
    name_tokens = set(_re.findall(r"[a-z0-9]+", name.lower()))

    def rank(fns):
        """Score candidate filenames by token containment; prefer variations
        that START with the wanted one over mere containment. Returns ALL
        matches best-first — the top pick can still 404 on dodo.ac (wiki
        redirects like 'Metal-And-Wood' vs the real 'Metal-and-Wood'), so the
        caller must walk the list."""
        out = []  # (startswith_first, exact_base, -len(base_part), fn)
        for fn in dict.fromkeys(fns):
            if '_NH_' not in fn or '_Storage_' in fn:
                continue
            m = _re.search(r'\((.*)\)_NH_', fn)
            pre_nh = fn.split('_NH_', 1)[0]
            tail = _re.search(r'\(([^()]*)\)$', pre_nh)
            base_part = pre_nh[:tail.start()] if tail else pre_nh
            fn_tokens = set(_re.findall(r"[a-z0-9]+", base_part.lower()))
            if not (name_tokens <= fn_tokens):
                continue
            file_v = _re.sub(r'\s+', ' ', m.group(1)).strip().lower() if m else ''
            starts = 1
            if want_tokens:
                toks = set(_re.findall(r"[a-z0-9]+", file_v))
                if not want_tokens <= toks:
                    continue
                starts = 0 if _re.sub(r'[^a-z0-9]', '', file_v).startswith(
                    _re.sub(r'[^a-z0-9]', '', want_v)) else 1
            elif _re.sub(r'[^a-z0-9]', '', want_v) != _re.sub(r'[^a-z0-9]', '', file_v):
                # Base icon wanted but this file carries a variant qualifier.
                # Some items ONLY have per-variant files on the wiki ('Circle
                # Cushion (White)', no bare icon) — keep them as a last resort
                # rather than reporting the item unfixable.
                if m is None:
                    continue
                starts = 2
            exact = 0 if _re.sub(r'[^a-z0-9]', '', name.lower()) == \
                _re.sub(r'[^a-z0-9]', '', base_part.lower()) else 1
            cand = (starts, exact, -len(base_part), fn)
            out.append(cand)
        return [c[3] for c in sorted(out)]

    words = name.split()
    if not words:
        return None, None
    probes = list(dict.fromkeys([
        titlecase(name).replace(' ', '_'),
        titlecase_hyphen(name).replace(' ', '_'),
        titlecase(words[0]).replace(' ', '_'),
        titlecase_hyphen(words[0]).replace(' ', '_'),
    ]))
    fn = None
    cands = []
    for base in probes:
        cands.extend(n.replace(' ', '_')
                     for n in _wiki_allimages_filenames(base))
    ranked = rank(cands)
    if fn is None:
        # Prefix probing loses when wiki punctuation/casing differs anywhere
        # after the first char ('Peacoat-and-Skirt Combo', "Tam-o'-Shanter",
        # 'Bird-of-Paradise'). File-namespace fulltext search doesn't care —
        # but hyphens read as exclusions and quotes break the query, so strip.
        try:
            clean = _re.sub(r"[^\w ]+", " ", name + " " + want_v)
            clean = _re.sub(r"\s+", " ", clean).strip()
            q = {"action": "query", "format": "json", "list": "search",
                 "srsearch": clean,
                 "srnamespace": "6", "srlimit": "50"}
            url = "https://nookipedia.com/w/api.php?" + urllib.parse.urlencode(q)
            d = json.loads(http_get(url).decode())
            hits = [r["title"].removeprefix("File:").replace(' ', '_')
                    for r in d.get("query", {}).get("search", [])]
            if not ranked:
                ranked = rank(hits)
            else:
                # merge: prefix matches outrank search-only hits on ties
                extra = [f for f in rank(hits) if f not in ranked]
                ranked = ranked + extra
        except Exception:
            pass

    for fn in ranked:
        data = _cache_bytes(fn)
        if data is None:
            try:
                data = try_fetch(fn)
            except Exception:
                data = None
            if data:
                with open(os.path.join(CACHE_DIR, fn), "wb") as f:
                    f.write(data)
        if data:
            return fn, maybe_thumb(fn, data)
    return None, None


def build_house_data(db, sheets, no_images, img_dir=None, image_urls=None):
    """Create + fill house_items (exact variant colors) and house_images
    (interior/exterior photos, full quality). Skips gracefully on network errors.
    If img_dir is set, write images to disk and store URLs instead of BLOBs."""
    print("[2c/4] house data (Nookipedia nh_house) ...")
    db.execute("CREATE TABLE house_items (villager TEXT, name TEXT, category TEXT,"
               " color1 TEXT, color2 TEXT)")
    db.execute("CREATE TABLE house_images (villager TEXT, kind TEXT,"
               " url TEXT, PRIMARY KEY (villager, kind))")
    db.execute("CREATE TABLE house_item_images (villager TEXT, name TEXT,"
               " url TEXT, PRIMARY KEY (villager, name))")
    try:
        cargo = fetch_nh_house()
    except Exception as e:
        print(f"    WARN: nh_house fetch failed ({e}); house section will fall back")
        return
    lookup = build_variant_lookup(sheets)
    # Load manual overrides for villagers with missing Nookipedia URLs
    overrides_path = os.path.join(HERE, "house_overrides.json")
    house_overrides = {}
    if os.path.exists(overrides_path):
        with open(overrides_path) as f:
            house_overrides = json.load(f)
        # Remove comment keys
        house_overrides = {k: v for k, v in house_overrides.items() if not k.startswith('_')}
    rows = cargo.get("cargoquery", [])
    n_items = 0
    n_villagers = 0
    for r in rows:
        t = r.get("title", {})
        villager = t.get("name_sort", "")
        if not villager:
            continue
        try:
            items = json.loads(_html.unescape(t.get("items") or ""))
        except (ValueError, TypeError):
            items = []
        icon_tasks = []
        for it in items:
            nm = it.get("name", "")
            var = house_variation_from_url(it.get("image_url", ""))
            norm = re.sub(r'[\s-]+', ' ', nm.strip().lower())
            # Manual override always wins: Nookipedia's URL may carry the wrong
            # variation (e.g. Ione's blue TV when her house is black), and for
            # many villagers the URL is empty so the base would be used anyway.
            override_key = f"{villager}/{nm}"
            # Villager names may carry accents (e.g. 'Viché', 'Renée') that the
            # override keys omit, so match accent-insensitively.
            override_key_flat = f"{strip_accents(villager)}/{nm}"
            override = override_key in house_overrides or override_key_flat in house_overrides
            if override:
                var = house_overrides.get(override_key, house_overrides.get(override_key_flat))
            hit = resolve_house_variant(lookup.get(norm), var)
            if not hit:
                continue
            db.execute("INSERT INTO house_items VALUES (?,?,?,?,?)",
                       (villager, hit["name"], hit["category"], hit["c1"], hit["c2"]))
            n_items += 1
            if not no_images:
                icon_tasks.append((hit, it.get("image_url", ""), override,
                                   var if override else None))
        if not no_images:
            # Exact per-villager item icons (also covers clothing like chef's
            # outfit, which the furniture-only images query would miss). For
            # overridden items the original Nookipedia URL is missing/wrong, so
            # fetch the exact icon for the *overridden* variation instead (full
            # "Body - Pattern" string, e.g. 'Green - Blue gingham').
            for hit, url, override, ov_var in icon_tasks:
                icon = None
                if override:
                    if ov_var and ov_var.strip().lower() not in ("na", "none"):
                        fn, icon = fetch_variant_icon(hit["name"], ov_var)
                    if icon is None:
                        base_cands = list(dict.fromkeys([
                            titlecase(hit["name"]).replace(' ', '_') + "_NH_Icon.png",
                            titlecase_hyphen(hit["name"]).replace(' ', '_') + "_NH_Icon.png",
                            hit["name"].replace(' ', '_') + "_NH_Icon.png",
                        ]))
                        for base_fn in base_cands:
                            data = _cache_bytes(base_fn)
                            if data is None:
                                data = try_fetch(base_fn)
                                if data:
                                    with open(os.path.join(CACHE_DIR, base_fn), "wb") as f:
                                        f.write(data)
                            if data:
                                icon, fn = maybe_thumb(base_fn, data), base_fn
                                break
                else:
                    icon = cached_item_icon(url)
                    if icon:
                        icon = maybe_thumb(urllib.parse.unquote(url.split('/')[-1]), icon)
                if not icon:
                    continue
                if img_dir:
                    iv_url = save_image(img_dir, villager, hit["name"], icon, image_urls)
                    db.execute("INSERT OR REPLACE INTO house_item_images VALUES (?,?,?)",
                               (villager, hit["name"], iv_url))
                else:
                    db.execute("INSERT OR REPLACE INTO house_item_images VALUES (?,?,?)",
                               (villager, hit["name"], sqlite3.Binary(icon)))
                # Backfill the generic images table with the exact icon so gift
                # suggestions also get it (fixes names the pattern-guesser misses,
                # e.g. cream and sugar -> Cream_%26_Sugar on the wiki).
                back_var = (ov_var if override else
                            (house_variation_from_url(url)
                             if (hit.get("var_raw") or "").strip().lower() in ("", "na", "none")
                             else hit["var_raw"]))
                if img_dir:
                    back_stem = sanitize_filename(hit["name"]) + (f'_{sanitize_filename(back_var)}' if back_var else '')
                    back_url = save_image(img_dir, hit["category"], back_stem, icon, image_urls)
                    db.execute("INSERT OR REPLACE INTO images VALUES (?,?,?,?)",
                               (hit["category"], hit["name"], back_var, back_url))
                else:
                    db.execute("INSERT OR REPLACE INTO images VALUES (?,?,?,?,?)",
                               (hit["category"], hit["name"], back_var,
                                sqlite3.Binary(icon), url))
            for kind, field in (("interior", "interior_image_url"),
                                ("exterior", "exterior_image_url")):
                url = t.get(field)
                if not url:
                    continue
                key = f"{villager.replace(' ', '_')}_{kind}.img"
                try:
                    data = cached_house_image(url, key)
                except Exception:
                    continue
                if data:
                    if img_dir:
                        hp_url = save_image(img_dir, villager, kind, data, image_urls)
                        db.execute("INSERT OR REPLACE INTO house_images VALUES (?,?,?)",
                                   (villager, kind, hp_url))
                    else:
                        db.execute("INSERT OR REPLACE INTO house_images VALUES (?,?,?)",
                                   (villager, kind, sqlite3.Binary(data)))
        n_villagers += 1
    print(f"    {n_villagers} villagers, {n_items} house items resolved")


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
    img_dir = os.path.join(os.path.dirname(OUT_DB), 'img') if not no_images else None
    if img_dir:
        os.makedirs(img_dir, exist_ok=True)
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
    db.execute("CREATE TABLE images (category TEXT, name TEXT, variation TEXT,"
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

    # per-villager house data (exact furniture colors + interior/exterior photos)
    image_urls = []
    build_house_data(db, sheets, no_images, img_dir=img_dir, image_urls=image_urls)

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
            for d in (IMAGES_RAW, CACHE_DIR, HOUSE_IMG_CACHE):
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

            def get_or_fetch(fn):
                """Return cached bytes for fn, or fetch+cache from dodo.ac."""
                data = get_cache_bytes(fn)
                if data is None:
                    data = try_fetch(fn)
                    if data:
                        with open(os.path.join(CACHE_DIR, fn), "wb") as f:
                            f.write(data)
                return data

            # Exact variation icons FIRST (e.g. Soft-Serve_Lamp_(Strawberry_Swirl))
            # — the base icon exists for most items and must not shadow them.
            if vpats:
                v = titlecase(var).replace(' ', '_')
                for base in dict.fromkeys(bases):
                    for pat in vpats:
                        fn = pat.format(n=base, v=v)
                        data = get_or_fetch(fn)
                        if data:
                            data = maybe_thumb(fn, data)
                        if data:
                            return cat, name, var, fn, data
            for base in dict.fromkeys(bases):
                for pat in pats:
                    fn = pat.format(n=base)
                    data = get_or_fetch(fn)
                    if data:
                        data = maybe_thumb(fn, data)
                    if data:
                        return cat, name, var, fn, data
            _, reg_data = registry_icon_for(name, var)
            if reg_data:
                return cat, name, var, None, reg_data
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
                    if img_dir:
                        stem = sanitize_filename(name) + (f'_{sanitize_filename(var)}' if var else '')
                        url = save_image(img_dir, cat, stem, data, image_urls)
                        db.execute("INSERT OR REPLACE INTO images VALUES (?,?,?,?)",
                                   (cat, name, var, url))
                    else:
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

    # Generate image manifest
    img_manifest_path = None
    image_hash = ''
    if img_dir and image_urls:
        image_urls.sort()
        image_hash = hashlib.sha256('\n'.join(image_urls).encode()).hexdigest()

        # Build the single-file install bundle: a stored zip (webp is already
        # compressed, so deflate gains nothing) of every webp image at its
        # /img/... path. The client downloads this ONE file on install.
        zip_path = os.path.join(img_dir, 'images.zip')
        zip_tmp = zip_path + '.tmp'
        if os.path.exists(zip_tmp):
            os.remove(zip_tmp)
        total_bytes = 0
        with zipfile.ZipFile(zip_tmp, 'w', zipfile.ZIP_STORED, allowZip64=True) as zf:
            for root, _, files in os.walk(img_dir):
                for fn in files:
                    if not fn.endswith('.webp'):
                        continue
                    full = os.path.join(root, fn)
                    zf.write(full, os.path.relpath(full, img_dir))
                    total_bytes += os.path.getsize(full)
        os.replace(zip_tmp, zip_path)
        zip_size = os.path.getsize(zip_path)
        print(f"    img bundle: {os.path.basename(zip_path)} = {zip_size/1e6:.1f} MB "
              f"({total_bytes/1e6:.1f} MB extracted)")

        img_manifest_path = os.path.join(img_dir, 'manifest.json')
        manifest_tmp = img_manifest_path + '.tmp'
        with open(manifest_tmp, 'w') as f:
            json.dump({'hash': image_hash, 'count': len(image_urls),
                       'urls': image_urls, 'zipSize': zip_size,
                       'totalBytes': total_bytes,
                       'zipName': 'images.zip'}, f)
        os.replace(manifest_tmp, img_manifest_path)
        print(f"    img manifest: {len(image_urls)} urls, hash={image_hash[:12]}…")

    # Strip image BLOBs from the DB (images are now files on disk)
    if img_dir:
        db.execute("CREATE TABLE images_new (category TEXT, name TEXT,"
                   " variation TEXT, url TEXT,"
                   " PRIMARY KEY (category, name, variation))")
        db.execute("INSERT INTO images_new SELECT category, name, variation, url FROM images")
        db.execute("DROP TABLE images")
        db.execute("ALTER TABLE images_new RENAME TO images")
        db.execute("CREATE TABLE hi_new (villager TEXT, name TEXT, url TEXT,"
                   " PRIMARY KEY (villager, name))")
        db.execute("INSERT INTO hi_new SELECT villager, name, url FROM house_item_images")
        db.execute("DROP TABLE house_item_images")
        db.execute("ALTER TABLE hi_new RENAME TO house_item_images")
        db.execute("CREATE TABLE hp_new (villager TEXT, kind TEXT, url TEXT,"
                   " PRIMARY KEY (villager, kind))")
        db.execute("INSERT INTO hp_new SELECT villager, kind, url FROM house_images")
        db.execute("DROP TABLE house_images")
        db.execute("ALTER TABLE hp_new RENAME TO house_images")
        db.commit()
        db.execute("VACUUM")

    print(f"[4/4] writing db + gz ...")
    # Store imageHash in the meta table for the client manifest
    if image_hash:
        db.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)",
                   ('image_hash', image_hash))
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
    if img_dir:
        img_count = sum(1 for _ in os.walk(img_dir) for f in _[2] if f.endswith('.png'))
        img_bytes = sum(os.path.getsize(os.path.join(d, f))
                        for d, _, files in os.walk(img_dir) for f in files if f.endswith('.png'))
        webp_bytes = sum(os.path.getsize(os.path.join(d, f))
                         for d, _, files in os.walk(img_dir) for f in files if f.endswith('.webp'))
        print(f"  img/               : {img_count} PNG (pristine) + {webp_bytes/1e6:.1f} MB WebP (served)")
    if thumb:
        print(f"  (images downscaled to max {thumb}px)")


if __name__ == "__main__":
    main()
