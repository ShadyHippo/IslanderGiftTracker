package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
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
	mu    sync.Mutex
	keys  map[string]string // file path -> composite key (mtime+size)
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
	// Never cache: the client must always see fresh sha256 values.
	w.Header().Set("Cache-Control", "no-store")
 writeJSON(w, http.StatusOK, map[string]any{"latest": latestVersion(entries), "references": entries, "imageHash": s.imageHash()})
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
	if _, err := os.Stat(abs); err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such reference"})
		return
	}
	// Same URL can carry new content (dev rebuilds; version bumps in prod are
	// expected too). Force revalidation; http.ServeFile supplies Last-Modified
	// + Range support for resume of large downloads.
	w.Header().Set("Cache-Control", "no-cache")
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

var imgFileRe = regexp.MustCompile(`^[a-z0-9_]+\.png$`)

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
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(data)
}

// imageHash returns the image hash from the meta table of the latest reference DB,
// or empty string if unavailable.
func (s *server) imageHash() string {
	entries, err := s.referenceEntries()
	if err != nil || len(entries) == 0 {
		return ""
	}
	latest := entries[0]
	dbPath := filepath.Join(s.refDir, latest.File)
	// The .gz file is what we have; we can't read meta from it directly.
	// Instead, read from the image manifest if available.
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
	_ = dbPath
	return m.Hash
}
