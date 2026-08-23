package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- fake OIDC provider -----------------------------------------------------

const (
	testKid      = "test-key"
	testClientID = "test-client-id"
)

var (
	testRSAKey   *rsa.PrivateKey
	testRSAKeyMu sync.Mutex
)

func testKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	testRSAKeyMu.Lock()
	defer testRSAKeyMu.Unlock()
	if testRSAKey == nil {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatalf("generate rsa key: %v", err)
		}
		testRSAKey = k
	}
	return testRSAKey
}

// fakeIdP serves a minimal but real-shape OIDC surface: discovery, JWKS, and a
// token endpoint that mints an RS256 id_token for whatever claims are loaded.
type fakeIdP struct {
	srv    *httptest.Server
	claims idClaims // mutated between logins by tests
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	p := &fakeIdP{}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{
			"issuer":                 p.srv.URL,
			"authorization_endpoint": p.srv.URL + "/authorize",
			"token_endpoint":         p.srv.URL + "/token",
			"jwks_uri":               p.srv.URL + "/jwks.json",
		})
	})
	mux.HandleFunc("/jwks.json", func(w http.ResponseWriter, _ *http.Request) {
		k := testKey(t).PublicKey
		writeJSON(w, http.StatusOK, map[string]any{
			"keys": []map[string]string{{
				"kid": testKid,
				"kty": "RSA",
				"n":   base64.RawURLEncoding.EncodeToString(k.N.Bytes()),
				"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(k.E)).Bytes()),
			}},
		})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil || r.Form.Get("code") != "good-code" ||
			r.Form.Get("grant_type") != "authorization_code" ||
			r.Form.Get("client_id") != testClientID ||
			r.Form.Get("client_secret") == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"id_token": p.mintIDToken(t)})
	})
	p.srv = httptest.NewServer(mux)
	t.Cleanup(p.srv.Close)
	return p
}

func (p *fakeIdP) mintIDToken(t *testing.T) string {
	t.Helper()
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": testKid})
	c := p.claims
	if c.Iss == "" {
		c.Iss = p.srv.URL
	}
	if len(c.Aud) == 0 {
		c.Aud = audience{testClientID}
	}
	if c.Exp == 0 {
		c.Exp = time.Now().Add(10 * time.Minute).Unix()
	}
	payload, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	signing := base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, testKey(t), crypto.SHA256, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func defaultClaims(issuer, sub, email string) idClaims {
	return idClaims{Iss: issuer, Aud: audience{testClientID}, Sub: sub, Email: email, EmailVerified: true}
}

// --- harness ----------------------------------------------------------------

func newTestGoogleServer(t *testing.T, idp *fakeIdP) (*server, http.Handler) {
	t.Helper()
	db := tempUsersDB(t)
	cfg := config{
		authMode:           "google",
		googleClientID:     testClientID,
		googleClientSecret: "test-secret",
		googleIssuer:       idp.srv.URL,
		secureCookies:      true,
	}
	s := &server{
		cfg:        cfg,
		usersDB:    db,
		sessions:   newSessionStore(),
		refDir:     t.TempDir(),
		progDir:    t.TempDir(),
		loginLimit: newLoginLimiter(1000, time.Minute),
		oauth:      newOAuthClient(cfg),
	}
	return s, newMux(s)
}

// doGoogleLogin drives start -> callback through the real handlers and returns
// the issued session token ("" when login was rejected) plus the final
// redirect target so tests can distinguish success from error bounces.
func doGoogleLogin(t *testing.T, h http.Handler) (string, string) {
	t.Helper()
	start := httptest.NewRequest("GET", "/api/auth/google/start", nil)
	start.Header.Set("X-Forwarded-Proto", "https")
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, start)
	res1 := w1.Result()
	authURL, err := url.Parse(res1.Header.Get("Location"))
	if res1.StatusCode != http.StatusFound || err != nil {
		t.Fatalf("start: want 302, got %d (%v)", res1.StatusCode, err)
	}
	var stateCookie *http.Cookie
	for _, c := range res1.Cookies() {
		if c.Name == oauthStateCookie {
			stateCookie = c
		}
	}
	if stateCookie == nil {
		t.Fatal("start did not set state cookie")
	}
	var loc string
	q := authURL.Query()
	if q.Get("state") != stateCookie.Value {
		t.Fatal("authorize URL state does not match state cookie")
	}

	cb := httptest.NewRequest("GET", "/api/auth/google/callback?code=good-code&state="+url.QueryEscape(stateCookie.Value), nil)
	cb.Header.Set("X-Forwarded-Proto", "https")
	cb.AddCookie(stateCookie)
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, cb)
	res2 := w2.Result()
	if res2.StatusCode != http.StatusFound {
		body := w2.Body.String()
		t.Fatalf("callback: want 302, got %d body=%s", res2.StatusCode, body)
	}
	loc = res2.Header.Get("Location")
	for _, c := range res2.Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			return c.Value, loc
		}
	}
	return "", loc // rejected flows clear the cookie instead of issuing one
}

// --- tests ------------------------------------------------------------------

func TestGoogleSignupCreatesAccount(t *testing.T) {
	idp := newFakeIdP(t)
	idp.claims = defaultClaims("", "sub-123", "Daisy@gmail.com")
	s, h := newTestGoogleServer(t, idp)

	tok, _ := doGoogleLogin(t, h)
	if tok == "" {
		t.Fatal("expected session cookie on signup")
	}
	// Username is the lowercased email; display decision is the email itself.
	me := httptest.NewRequest("GET", "/api/me", nil)
	me.AddCookie(&http.Cookie{Name: sessionCookie, Value: tok})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, me)
	if !strings.Contains(w.Body.String(), `"username":"daisy@gmail.com"`) {
		t.Fatalf("api/me = %s", w.Body.String())
	}
	// Second login with the same sub resolves to the SAME account (no dupes).
	tok2, _ := doGoogleLogin(t, h)
	if tok2 == "" {
		t.Fatal("expected session on re-login")
	}
	var count int
	if err := s.usersDB.QueryRow("SELECT COUNT(*) FROM users").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("want 1 user after two logins, got %d", count)
	}
}

func TestGoogleLinksExistingEmailAccount(t *testing.T) {
	idp := newFakeIdP(t)
	idp.claims = defaultClaims("", "sub-link", "mabel@gmail.com")
	s, h := newTestGoogleServer(t, idp)

	// A pre-existing password account owning that email address.
	if err := createUser(s.usersDB, "mabel", "old-password"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.usersDB.Exec("UPDATE users SET email = 'Mabel@gmail.com' WHERE username = 'mabel'"); err != nil {
		t.Fatal(err)
	}

	if tok, _ := doGoogleLogin(t, h); tok == "" {
		t.Fatal("expected session after linking")
	}
	canonical, ok, err := verifyUser(s.usersDB, "mabel", "old-password")
	if err != nil || !ok || canonical != "mabel" {
		t.Fatalf("password login should keep working: %v %v %v", canonical, ok, err)
	}
	var sub string
	if err := s.usersDB.QueryRow("SELECT google_sub FROM users WHERE username='mabel'").Scan(&sub); err != nil || sub != "sub-link" {
		t.Fatalf("google_sub not linked: %q %v", sub, err)
	}
}

func TestGoogleRejectsUnverifiedEmail(t *testing.T) {
	idp := newFakeIdP(t)
	idp.claims = defaultClaims("", "sub-bad", "sneaky@gmail.com")
	idp.claims.EmailVerified = false
	s, h := newTestGoogleServer(t, idp)

	tok, loc := doGoogleLogin(t, h)
	if tok != "" {
		t.Fatal("unverified email must not get a session")
	}
	if !strings.HasPrefix(loc, "/?login_error=") {
		t.Fatalf("unverified email should bounce with an error, got %q", loc)
	}
	var count int
	_ = s.usersDB.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	if count != 0 {
		t.Fatalf("no account should be created, got %d", count)
	}
}

func TestGoogleRejectsTamperedState(t *testing.T) {
	idp := newFakeIdP(t)
	idp.claims = defaultClaims("", "sub-t", "t@example.com")
	s, h := newTestGoogleServer(t, idp)

	start := httptest.NewRequest("GET", "/api/auth/google/start", nil)
	start.Header.Set("X-Forwarded-Proto", "https")
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, start)
	var state *http.Cookie
	for _, c := range w1.Result().Cookies() {
		if c.Name == oauthStateCookie {
			state = c
		}
	}
	state.Value += "tampered"
	cb := httptest.NewRequest("GET", "/api/auth/google/callback?code=good-code&state="+url.QueryEscape(state.Value), nil)
	cb.AddCookie(state)
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, cb)
	if strings.HasPrefix(w2.Result().Header.Get("Location"), "/api") {
		t.Fatal("tampered state should bounce to / with an error, not continue")
	}
	var count int
	_ = s.usersDB.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	if count != 0 {
		t.Fatal("no account should be created on tampered state")
	}
}

func TestGoogleUsernameCollisionSuffix(t *testing.T) {
	idp := newFakeIdP(t)
	idp.claims = defaultClaims("", "sub-x", "taken@gmail.com")
	s, h := newTestGoogleServer(t, idp)

	// A password-mode user already owns that exact username.
	if err := createUser(s.usersDB, "taken@gmail.com", "pw"); err != nil {
		t.Fatal(err)
	}
	if tok, _ := doGoogleLogin(t, h); tok == "" {
		t.Fatal("expected session despite username collision")
	}
	var uname string
	if err := s.usersDB.QueryRow("SELECT username FROM users WHERE google_sub='sub-x'").Scan(&uname); err != nil {
		t.Fatal(err)
	}
	if uname != "taken@gmail.com-1" {
		t.Fatalf("collision suffix wrong: %q", uname)
	}
}

func TestDeleteAccountRemovesEverything(t *testing.T) {
	idp := newFakeIdP(t)
	idp.claims = defaultClaims("", "sub-del", "gone@gmail.com")
	s, h := newTestGoogleServer(t, idp)

	tok, _ := doGoogleLogin(t, h)
	if tok == "" {
		t.Fatal("expected session")
	}
	username := "gone@gmail.com"
	prog := filepath.Join(s.progDir, username+".db")
	backup := filepath.Join(s.backupDir(), username+"-20260821-000000.db")
	_ = os.MkdirAll(s.backupDir(), 0o755)
	for _, f := range []string{prog, backup} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	req := httptest.NewRequest("DELETE", "/api/account", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookie, Value: tok})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("delete account: got %d body=%s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(prog); !os.IsNotExist(err) {
		t.Error("progress file survived deletion")
	}
	if _, err := os.Stat(backup); !os.IsNotExist(err) {
		t.Error("backup survived deletion")
	}
	var count int
	_ = s.usersDB.QueryRow("SELECT COUNT(*) FROM users").Scan(&count)
	if count != 0 {
		t.Error("user row survived deletion")
	}
	me := httptest.NewRequest("GET", "/api/me", nil)
	me.AddCookie(&http.Cookie{Name: sessionCookie, Value: tok})
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, me)
	if w2.Code != http.StatusUnauthorized {
		t.Error("session should be invalid after account deletion")
	}
}

func TestAuthConfigEndpoint(t *testing.T) {
	idp := newFakeIdP(t)
	_, gh := newTestGoogleServer(t, idp)
	w := httptest.NewRecorder()
	gh.ServeHTTP(w, httptest.NewRequest("GET", "/api/auth/config", nil))
	body := w.Body.String()
	if !strings.Contains(body, `"mode":"google"`) || !strings.Contains(body, testClientID) {
		t.Fatalf("google config = %s", body)
	}

	db := tempUsersDB(t)
	ps := &server{
		cfg:        config{authMode: "password", staticDir: "nonexistent"},
		usersDB:    db,
		sessions:   newSessionStore(),
		refDir:     t.TempDir(),
		progDir:    t.TempDir(),
		loginLimit: newLoginLimiter(1000, time.Minute),
	}
	w2 := httptest.NewRecorder()
	newMux(ps).ServeHTTP(w2, httptest.NewRequest("GET", "/api/auth/config", nil))
	if !strings.Contains(w2.Body.String(), `"mode":"password"`) {
		t.Fatalf("password config = %s", w2.Body.String())
	}
}

func TestUsersSchemaMigrationPreservesPasswords(t *testing.T) {
	db := tempUsersDB(t)
	// Force the legacy shape back (pre-google schema had NOT NULL hash).
	stmts := []string{
		`DROP TABLE IF EXISTS users_old`,
		`ALTER TABLE users RENAME TO users_old`,
		`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
		`INSERT INTO users (id, username, password_hash, created_at) SELECT id, username, password_hash, created_at FROM users_old`,
		`DROP TABLE users_old`,
	}
	for _, q := range stmts {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("downgrade: %v", err)
		}
	}
	if err := createUser(db, "legacy-user", "legacy-pass"); err != nil {
		t.Fatal(err)
	}
	if err := migrateUsersSchema(db); err != nil {
		t.Fatalf("migration failed: %v", err)
	}
	canonical, ok, err := verifyUser(db, "legacy-user", "legacy-pass")
	if err != nil || !ok {
		t.Fatalf("legacy password broken by migration: canonical=%q ok=%v err=%v", canonical, ok, err)
	}
	// Google-mode inserts now succeed against the migrated table.
	uname, err := findOrCreateGoogleUser(db, "sub-mig", "mig@example.com")
	if err != nil || uname != "mig@example.com" {
		t.Fatalf("insert after migration: %q %v", uname, err)
	}
}
