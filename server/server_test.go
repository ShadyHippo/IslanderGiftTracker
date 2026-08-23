package main

import (
	"bytes"
	"database/sql"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newTestServer builds a full server + mux with temp storage.
func newTestServer(t *testing.T, staticDir string) *httptest.Server {
	t.Helper()
	dataDir := t.TempDir()
	db := tempUsersDB(t)
	if err := createUser(db, "testuser", "testpass"); err != nil {
		t.Fatal(err)
	}
	srv := &server{
		cfg:        config{staticDir: staticDir, dataDir: dataDir},
		usersDB:    db,
		sessions:   newSessionStore(),
		refDir:     filepath.Join(dataDir, "ref"),
		progDir:    filepath.Join(dataDir, "progress"),
		loginLimit: newLoginLimiter(100, time.Minute),
	}
	for _, d := range []string{srv.refDir, srv.progDir, srv.backupDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	ts := httptest.NewServer(newMux(srv))
	t.Cleanup(ts.Close)
	return ts
}

func makeValidDB(t *testing.T) []byte {
	t.Helper()
	path := filepath.Join(t.TempDir(), "p.db")
	db, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(progressTemplate); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO gifts (villager,item,date,created_at) VALUES ('Ankha','Rose','2026-08-13','now')`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func login(t *testing.T, ts *httptest.Server, user, pass string) (*http.Response, []*http.Cookie) {
	t.Helper()
	body := bytes.NewBufferString(`{"username":"` + user + `","password":"` + pass + `"}`)
	req, _ := http.NewRequest("POST", ts.URL+"/api/login", body)
	req.Header.Set("Content-Type", "application/json")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp, resp.Cookies()
}

func TestAuthFlow(t *testing.T) {
	ts := newTestServer(t, filepath.Join(t.TempDir(), "nonexistent"))

	resp, _ := login(t, ts, "testuser", "wrong")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong password: status = %d, want 401", resp.StatusCode)
	}

	resp, cookies := login(t, ts, "testuser", "testpass")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login: status = %d, want 200", resp.StatusCode)
	}
	if len(cookies) == 0 {
		t.Fatal("login should set a cookie")
	}

	req, _ := http.NewRequest("GET", ts.URL+"/api/me", nil)
	req.AddCookie(cookies[0])
	me, _ := ts.Client().Do(req)
	body, _ := io.ReadAll(me.Body)
	me.Body.Close()
	if !strings.Contains(string(body), `"testuser"`) {
		t.Fatalf("me: body = %s", body)
	}

	req, _ = http.NewRequest("POST", ts.URL+"/api/logout", nil)
	req.AddCookie(cookies[0])
	ts.Client().Do(req)

	req, _ = http.NewRequest("GET", ts.URL+"/api/me", nil)
	req.AddCookie(cookies[0])
	after, _ := ts.Client().Do(req)
	if after.StatusCode != http.StatusUnauthorized {
		t.Fatalf("me after logout: status = %d, want 401", after.StatusCode)
	}
	io.Copy(io.Discard, after.Body)
	after.Body.Close()
}

func TestLoginPasswordTooLong(t *testing.T) {
	ts := newTestServer(t, filepath.Join(t.TempDir(), "nonexistent"))
	body := bytes.NewBufferString(`{"username":"testuser","password":"` + strings.Repeat("x", 80) + `"}`)
	req, _ := http.NewRequest("POST", ts.URL+"/api/login", body)
	req.Header.Set("Content-Type", "application/json")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("over-long password: status = %d, want 400", resp.StatusCode)
	}
}

func TestProgressFlow(t *testing.T) {
	ts := newTestServer(t, filepath.Join(t.TempDir(), "nonexistent"))
	_, cookies := login(t, ts, "testuser", "testpass")
	jar := cookies[0]

	get := func() *http.Response {
		req, _ := http.NewRequest("GET", ts.URL+"/api/progress", nil)
		req.AddCookie(jar)
		r, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	put := func(body []byte) *http.Response {
		req, _ := http.NewRequest("PUT", ts.URL+"/api/progress", bytes.NewReader(body))
		req.AddCookie(jar)
		r, err := ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return r
	}

	// First GET auto-creates the template.
	r := get()
	if r.StatusCode != 200 {
		t.Fatalf("progress get: %d", r.StatusCode)
	}
	io.Copy(io.Discard, r.Body)
	r.Body.Close()

	// Garbage rejected.
	r = put([]byte("definitely not a database"))
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("garbage upload: %d, want 400", r.StatusCode)
	}
	io.Copy(io.Discard, r.Body)
	r.Body.Close()

	// Valid upload accepted.
	valid := makeValidDB(t)
	r = put(valid)
	if r.StatusCode != 200 {
		t.Fatalf("valid upload: %d, want 200", r.StatusCode)
	}
	io.Copy(io.Discard, r.Body)
	r.Body.Close()

	// Second upload creates a backup.
	r = put(valid)
	if r.StatusCode != 200 {
		t.Fatalf("second upload: %d, want 200", r.StatusCode)
	}
	io.Copy(io.Discard, r.Body)
	r.Body.Close()

	req, _ := http.NewRequest("GET", ts.URL+"/api/progress/versions", nil)
	req.AddCookie(jar)
	vr, _ := ts.Client().Do(req)
	vb, _ := io.ReadAll(vr.Body)
	vr.Body.Close()
	if !strings.Contains(string(vb), `"versions":[`) || strings.Contains(string(vb), `"versions":[]`) {
		t.Fatalf("versions should list one backup: %s", vb)
	}
}

func TestLoginRateLimit(t *testing.T) {
	ts := newTestServer(t, filepath.Join(t.TempDir(), "nonexistent"))
	// Find the server and shrink its limiter to 2.
	// (newTestServer set 100; reach in via the returned handler is awkward,
	// so instead we hammer 101 times — slow. Use a second server instead.)
	_ = ts
	dataDir := t.TempDir()
	db := tempUsersDB(t)
	createUser(db, "testuser", "testpass")
	srv := &server{
		cfg:        config{staticDir: filepath.Join(t.TempDir(), "no"), dataDir: dataDir},
		usersDB:    db,
		sessions:   newSessionStore(),
		refDir:     filepath.Join(dataDir, "ref"),
		progDir:    filepath.Join(dataDir, "progress"),
		loginLimit: newLoginLimiter(2, time.Minute),
	}
	os.MkdirAll(srv.refDir, 0o755)
	os.MkdirAll(srv.progDir, 0o755)
	ts2 := httptest.NewServer(newMux(srv))
	defer ts2.Close()

	statuses := []int{}
	for i := 0; i < 3; i++ {
		resp, _ := login(t, ts2, "testuser", "wrong")
		statuses = append(statuses, resp.StatusCode)
	}
	if statuses[0] != 401 || statuses[1] != 401 {
		t.Fatalf("first two should be 401, got %v", statuses)
	}
	if statuses[2] != http.StatusTooManyRequests {
		t.Fatalf("third should be 429, got %v", statuses)
	}
}
