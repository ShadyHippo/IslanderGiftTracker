package main

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// newCacheTestServer builds a server over a ref dir containing a reference db,
// an image manifest and an image bundle.
func newCacheTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	refDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(refDir, "img"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(refDir, "reference.v1.db.gz"), []byte("refdb-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(refDir, "img", "images.zip"), []byte("zip-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	manifest := `{"hash":"bundlehash","count":0,"urls":[],"zipSize":9,"totalBytes":9}`
	if err := os.WriteFile(filepath.Join(refDir, "img", "manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	srv := &server{
		cfg:        config{},
		usersDB:    tempUsersDB(t),
		sessions:   newSessionStore(),
		refDir:     refDir,
		progDir:    t.TempDir(),
		loginLimit: newLoginLimiter(10, 0),
	}
	ts := httptest.NewServer(securityHeaders(newMux(srv), false))
	t.Cleanup(ts.Close)
	return ts
}

func get(t *testing.T, url string, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	return res
}

func TestManifestIsCacheableWithETag(t *testing.T) {
	ts := newCacheTestServer(t)
	res := get(t, ts.URL+"/db/manifest.json", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", res.StatusCode)
	}
	etag := res.Header.Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag")
	}
	if cc := res.Header.Get("Cache-Control"); cc == "" || cc == "no-store" {
		t.Fatalf("manifest must be cacheable, got %q", cc)
	}
	cond := get(t, ts.URL+"/db/manifest.json", map[string]string{"If-None-Match": etag})
	if cond.StatusCode != http.StatusNotModified {
		t.Fatalf("conditional GET = %d, want 304", cond.StatusCode)
	}
}

func TestImageManifestIsCacheableWithETag(t *testing.T) {
	ts := newCacheTestServer(t)
	res := get(t, ts.URL+"/img/manifest.json", nil)
	etag := res.Header.Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag on image manifest")
	}
	if res.Header.Get("Cache-Control") == "no-store" {
		t.Fatal("image manifest must not be no-store")
	}
	if got := get(t, ts.URL+"/img/manifest.json", map[string]string{"If-None-Match": etag}).StatusCode; got != http.StatusNotModified {
		t.Fatalf("conditional GET = %d, want 304", got)
	}
}

func TestContentAddressedDownloadsAreImmutable(t *testing.T) {
	ts := newCacheTestServer(t)
	sum := sha256.Sum256([]byte("refdb-bytes"))
	sha := hex.EncodeToString(sum[:])

	ok := get(t, ts.URL+"/db/reference.v1.db.gz?h="+sha, nil)
	if cc := ok.Header.Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
		t.Fatalf("pinned db cache-control = %q", cc)
	}
	// A hash that does not match the bytes must NOT be treated as immutable.
	bad := get(t, ts.URL+"/db/reference.v1.db.gz?h=deadbeef", nil)
	if cc := bad.Header.Get("Cache-Control"); cc != "no-cache" {
		t.Fatalf("unpinned db cache-control = %q, want no-cache", cc)
	}

	bundle := get(t, ts.URL+"/img/images.zip?h=bundlehash", nil)
	if cc := bundle.Header.Get("Cache-Control"); cc == "" || cc[:7] != "public," {
		t.Fatalf("pinned bundle cache-control = %q", cc)
	}
	unpinned := get(t, ts.URL+"/img/images.zip", nil)
	if cc := unpinned.Header.Get("Cache-Control"); cc == "" || cc[:7] != "public," {
		t.Fatalf("unpinned bundle cache-control = %q", cc)
	}
}
