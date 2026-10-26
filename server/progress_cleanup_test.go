package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// makeStateServer builds a server whose progDir the test can inspect.
func makeStateServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dataDir := t.TempDir()
	progDir := filepath.Join(dataDir, "progress")
	refDir := filepath.Join(dataDir, "ref")
	for _, d := range []string{progDir, refDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	db := tempUsersDB(t)
	if err := createUser(db, "testuser", "testpass"); err != nil {
		t.Fatal(err)
	}
	srv := &server{
		cfg:        config{},
		usersDB:    db,
		sessions:   newSessionStore(),
		refDir:     refDir,
		progDir:    progDir,
		loginLimit: newLoginLimiter(100, time.Minute),
	}
	ts := httptest.NewServer(securityHeaders(newMux(srv), false))
	t.Cleanup(ts.Close)
	return ts, progDir
}

func putProgress(t *testing.T, ts *httptest.Server, cookies []*http.Cookie, body []byte) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/progress", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.AddCookie(cookies[0])
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return resp
}

// An upload must not leave SQLite staging/sidecar files behind: they used to
// accumulate as <user>.db.uploading-shm / -wal next to the live database.
func TestUploadLeavesNoSideOrStagingFiles(t *testing.T) {
	ts, progDir := makeStateServer(t)
	_, cookies := login(t, ts, "testuser", "testpass")

	if got := putProgress(t, ts, cookies, makeValidDB(t)).StatusCode; got != http.StatusOK {
		t.Fatalf("PUT = %d", got)
	}
	entries, err := os.ReadDir(progDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		name := e.Name()
		if strings.Contains(name, ".uploading") || strings.HasSuffix(name, "-wal") || strings.HasSuffix(name, "-shm") {
			t.Errorf("leftover file after upload: %s", name)
		}
	}
	if len(entries) != 1 {
		t.Errorf("expected exactly the live db, got %d entries", len(entries))
	}
}

func TestBootRemovesStaleUploads(t *testing.T) {
	dir := t.TempDir()
	stale := []string{"a.db.uploading", "a.db.uploading-wal", "a.db.uploading-shm"}
	for _, n := range stale {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "a.db"), []byte("live"), 0o644); err != nil {
		t.Fatal(err)
	}
	removeStaleUploads(dir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "a.db" {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("expected only a.db, got %v", names)
	}
}

// Deleting an account must take its gift log, sidecars and staging leftovers.
func TestDeleteAccountRemovesAllArtifacts(t *testing.T) {
	ts, progDir := makeStateServer(t)
	_, cookies := login(t, ts, "testuser", "testpass")
	if got := putProgress(t, ts, cookies, makeValidDB(t)).StatusCode; got != http.StatusOK {
		t.Fatalf("PUT = %d", got)
	}
	// Simulate what an interrupted upload used to leave behind.
	for _, n := range []string{"testuser.db.uploading-shm", "testuser.db-wal"} {
		if err := os.WriteFile(filepath.Join(progDir, n), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	req, _ := http.NewRequest(http.MethodDelete, ts.URL+"/api/account", nil)
	req.AddCookie(cookies[0])
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE = %d", resp.StatusCode)
	}

	entries, err := os.ReadDir(progDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("account deletion left %v", names)
	}
}
