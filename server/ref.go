package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
)

var refFileRe = regexp.MustCompile(`^reference\.v(\d+)\.db\.gz$`)

type refEntry struct {
	Version int    `json:"version"`
	File    string `json:"file"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
}

// manifestCache memoizes hashes per (file, mtime, size) so we never re-hash the
// reference file more than once per change.
type manifestCache struct {
	mu     sync.Mutex
	keys   map[string]string // file path -> composite key (mtime+size)
	hashes map[string]string // file path -> sha256
}

var mcache = &manifestCache{keys: map[string]string{}, hashes: map[string]string{}}

func (s *server) referenceEntries() ([]refEntry, error) {
	matches, err := filepath.Glob(filepath.Join(s.refDir, "reference.*.db.gz"))
	if err != nil {
		return nil, err
	}
	var out []refEntry
	for _, m := range matches {
		name := filepath.Base(m)
		mm := refFileRe.FindStringSubmatch(name)
		if mm == nil {
			continue
		}
		st, err := os.Stat(m)
		if err != nil {
			continue
		}
		version, _ := strconv.Atoi(mm[1])
		out = append(out, refEntry{Version: version, File: name, Size: st.Size(), SHA256: s.fileHash(m, st)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version > out[j].Version })
	if out == nil {
		out = []refEntry{} // JSON: [] not null (no reference files yet)
	}
	return out, nil
}

func (s *server) fileHash(path string, st os.FileInfo) string {
	key := path + "|" + st.ModTime().UTC().String() + "|" + strconv.FormatInt(st.Size(), 10)
	mcache.mu.Lock()
	defer mcache.mu.Unlock()
	if mcache.keys[path] == key {
		return mcache.hashes[path]
	}
	h := sha256.New()
	if f, err := os.Open(path); err == nil {
		if _, err := io.Copy(h, f); err == nil {
			mcache.hashes[path] = hex.EncodeToString(h.Sum(nil))
			mcache.keys[path] = key
		}
		f.Close()
	}
	return mcache.hashes[path]
}

func (s *server) handleManifest(w http.ResponseWriter, r *http.Request) {
	entries, err := s.referenceEntries()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "scan failed"})
		return
	}
	// Short max-age with stale-while-revalidate: every boot reads this, so it
	// must be cacheable at the edge — but it is also the freshness oracle for
	// the reference db, so it may not go stale for long. The ETag turns the
	// revalidation into a bodyless 304.
	writeCachedJSON(w, r, http.StatusOK, map[string]any{"latest": latestVersion(entries), "references": entries, "imageHash": s.imageHash()}, 60)
}

func (s *server) handleRefDownload(w http.ResponseWriter, r *http.Request) {
	filename := r.PathValue("filename")
	if filename == "" || !refFileRe.MatchString(filename) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such reference"})
		return
	}
	// Resolve strictly inside refDir.
	abs := filepath.Join(s.refDir, filename)
	if filepath.Dir(abs) != s.refDir {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such reference"})
		return
	}
	st, err := os.Stat(abs)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such reference"})
		return
	}
	// Same URL can carry new content (dev rebuilds; version bumps in prod are
	// expected too). When the caller pins the content hash from the manifest we
	// can cache it like any immutable object; otherwise force revalidation.
	// http.ServeFile supplies Last-Modified + Range support for resume.
	if h := r.URL.Query().Get("h"); h != "" && strings.EqualFold(h, s.fileHash(abs, st)) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeFile(w, r, abs)
}

func latestVersion(entries []refEntry) int {
	latest := 0
	for _, e := range entries {
		if e.Version > latest {
			latest = e.Version
		}
	}
	return latest
}

var imgFileRe = regexp.MustCompile(`^[a-z0-9_]+\.(png|webp)$`)

func (s *server) handleImageFile(w http.ResponseWriter, r *http.Request) {
	category := r.PathValue("category")
	filename := r.PathValue("filename")
	if category == "" || filename == "" || !imgFileRe.MatchString(filename) {
		http.NotFound(w, r)
		return
	}
	abs := filepath.Join(s.refDir, "img", category, filename)
	// Prevent directory traversal: resolved path must be inside refDir/img/{category}/
	imgCategoryDir := filepath.Join(s.refDir, "img", category)
	if filepath.Dir(abs) != imgCategoryDir {
		http.NotFound(w, r)
		return
	}
	if _, err := os.Stat(abs); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(w, r, abs)
}

func (s *server) handleImageManifest(w http.ResponseWriter, r *http.Request) {
	abs := filepath.Join(s.refDir, "img", "manifest.json")
	data, err := os.ReadFile(abs)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "image manifest not available"})
		return
	}
	// This file is ~900 KB and every client reads it on boot purely to compare
	// its hash with what is installed on the device. Caching it at the edge
	// (with an ETag) is the difference between one origin read per client per
	// visit and one per few minutes.
	etag := ""
	if st, err := os.Stat(abs); err == nil {
		etag = `"` + s.fileHash(abs, st) + `"`
		w.Header().Set("ETag", etag)
	}
	w.Header().Set("Cache-Control", "public, max-age=300, stale-while-revalidate=86400")
	if etag != "" && etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

// handleImageBundle serves the single-file install bundle (stored zip of every
// webp image). The client asks for it with ?h=<manifest hash>; when that
// matches the bundle we serve, the edge may keep it for a week (the hash is
// derived from the URL list, not the bytes, so it is not "immutable forever").
// Without the marker it stays a short-lived cache entry.
func (s *server) handleImageBundle(w http.ResponseWriter, r *http.Request) {
	abs := filepath.Join(s.refDir, "img", "images.zip")
	if _, err := os.Stat(abs); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	if h := r.URL.Query().Get("h"); h != "" && strings.EqualFold(h, s.imageHash()) {
		w.Header().Set("Cache-Control", "public, max-age=604800, stale-while-revalidate=2592000")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=600, stale-while-revalidate=86400")
	}
	http.ServeFile(w, r, abs)
}

// imageHash returns the bundle identity published in the image manifest. It is
// deliberately independent of the reference db: a deployment can ship images
// without a newer db and the bundle should still be cache-pinned.
func (s *server) imageHash() string {
	manifestPath := filepath.Join(s.refDir, "img", "manifest.json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return ""
	}
	var m struct {
		Hash string `json:"hash"`
	}
	if json.Unmarshal(data, &m) != nil {
		return ""
	}
	return m.Hash
}

// writeCachedJSON writes a JSON body with a strong validator and an
// edge-friendly cache policy. Small manifests are read by every client on
// every boot; without a validator the origin re-sent them each time.
func writeCachedJSON(w http.ResponseWriter, r *http.Request, status int, v any, maxAge int) {
	body, err := json.Marshal(v)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "encode failed"})
		return
	}
	sum := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(sum[:16]) + `"`
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d, stale-while-revalidate=86400", maxAge))
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// etagMatches reports whether an If-None-Match header covers etag. Weak
// validators (W/"...") are compared on the opaque tag.
func etagMatches(header, etag string) bool {
	if header == "" {
		return false
	}
	if strings.TrimSpace(header) == "*" {
		return true
	}
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(part), "W/"))
		if part == etag {
			return true
		}
	}
	return false
}
