package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRefFileRe(t *testing.T) {
	cases := map[string]bool{
		"reference.v1.db.gz":   true,
		"reference.v99.db.gz":  true,
		"reference.v0.db.gz":   true,
		"reference.v1.db":      false,
		"reference.db.gz":      false,
		"ref.v1.db.gz":         false,
		"reference.v2.db.gz/..": false,
		"../reference.v2.db.gz": false,
	}
	for in, want := range cases {
		if got := refFileRe.MatchString(in); got != want {
			t.Errorf("refFileRe(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestLatestVersion(t *testing.T) {
	entries := []refEntry{{Version: 1}, {Version: 5}, {Version: 2}}
	if got := latestVersion(entries); got != 5 {
		t.Fatalf("latestVersion = %d, want 5", got)
	}
	if got := latestVersion(nil); got != 0 {
		t.Fatalf("latestVersion(nil) = %d, want 0", got)
	}
}

func TestManifestAndDownload(t *testing.T) {
	dir := t.TempDir()
	s := &server{refDir: dir}

	v1 := filepath.Join(dir, "reference.v1.db.gz")
	v2 := filepath.Join(dir, "reference.v2.db.gz")
	if err := os.WriteFile(v1, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(v2, []byte("new content"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Manifest
	rr := httptest.NewRecorder()
	s.handleManifest(rr, httptest.NewRequest("GET", "/db/manifest.json", nil))
	if rr.Code != 200 {
		t.Fatalf("manifest status = %d", rr.Code)
	}
	body := rr.Body.String()
	if !strings.Contains(body, `"latest":2`) {
		t.Fatalf("manifest missing latest=2: %s", body)
	}
	if !strings.Contains(body, "sha256") || !strings.Contains(body, `"version":1`) {
		t.Fatalf("manifest missing entries: %s", body)
	}

	// Valid download
	rr = httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/db/reference.v2.db.gz", nil)
	req.SetPathValue("filename", "reference.v2.db.gz")
	s.handleRefDownload(rr, req)
	if rr.Code != 200 || rr.Body.String() != "new content" {
		t.Fatalf("download: status=%d body=%q", rr.Code, rr.Body.String())
	}

	// Missing version
	rr = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/db/reference.v9.db.gz", nil)
	req.SetPathValue("filename", "reference.v9.db.gz")
	s.handleRefDownload(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("missing version status = %d, want 404", rr.Code)
	}

	// Bad filenames (traversal attempts) must 404
	for _, bad := range []string{"..%2Fetc%2Fpasswd", "reference.v1.db.gz.evil", "x", "../reference.v1.db.gz"} {
		rr = httptest.NewRecorder()
		req = httptest.NewRequest("GET", "/db/"+bad, nil)
		req.SetPathValue("filename", bad)
		s.handleRefDownload(rr, req)
		if rr.Code != http.StatusNotFound {
			t.Errorf("filename %q: status = %d, want 404", bad, rr.Code)
		}
	}
}
