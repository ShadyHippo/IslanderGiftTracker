package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

const (
	sessionCookie = "acnh_session"
	sessionTTL    = 30 * 24 * time.Hour
	bcryptCost    = 10
	// maxPasswordLen caps passwords at 64 bytes: bcrypt silently truncates
	// input at 72 bytes, so longer passwords would be compared only by their
	// first 72 bytes. Reject them up front instead of storing a footgun.
	maxPasswordLen = 64
	// maxSessions bounds the in-memory session table. Sessions are only
	// removed on logout or expiry (hourly sweep), so without a cap repeated
	// logins would grow the map forever.
	maxSessions = 10000
)

// dummyHash is a bcrypt hash used only to equalize response timing when a
// username doesn't exist, so login latency can't reveal which usernames are
// valid (user enumeration). It is never used to verify anyone.
var dummyHash = func() []byte {
	h, err := bcrypt.GenerateFromPassword([]byte("acnh-timing-equalizer"), bcryptCost)
	if err != nil {
		panic("acnh: generating dummy bcrypt hash: " + err.Error())
	}
	return h
}()

func initUsersSchema(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE NOT NULL,
		password_hash TEXT,
		google_sub TEXT UNIQUE,
		email TEXT UNIQUE,
		created_at TEXT NOT NULL
	)`)
	if err != nil {
		return err
	}
	return migrateUsersSchema(db)
}

// migrateUsersSchema upgrades pre-google-mode databases (whose password_hash
// was NOT NULL and which lacked google_sub/email) by rebuilding the table.
// One-time; detected via the presence of the google_sub column.
func migrateUsersSchema(db *sql.DB) error {
	hasGoogleSub := false
	rows, err := db.Query("PRAGMA table_info(users)")
	if err != nil {
		return err
	}
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			rows.Close()
			return err
		}
		if name == "google_sub" {
			hasGoogleSub = true
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if hasGoogleSub {
		return nil
	}
	stmts := []string{
		`DROP TABLE IF EXISTS users_old`,
		`ALTER TABLE users RENAME TO users_old`,
		`CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT,
			google_sub TEXT UNIQUE,
			email TEXT UNIQUE,
			created_at TEXT NOT NULL
		)`,
		`INSERT INTO users (id, username, password_hash, created_at)
			SELECT id, username, password_hash, created_at FROM users_old`,
		`DROP TABLE users_old`,
	}
	for _, q := range stmts {
		if _, err := db.Exec(q); err != nil {
			return fmt.Errorf("users schema migration: %w", err)
		}
	}
	log.Printf("users table migrated for google auth (existing passwords preserved)")
	return nil
}

func createUser(db *sql.DB, username, password string) error {
	username = strings.ToLower(strings.TrimSpace(username))
	if err := validUsername(username); err != nil {
		return err
	}
	if err := validatePassword(password); err != nil {
		return err
	}
	hash, err := bcryptHash(password)
	if err != nil {
		return err
	}
	_, err = db.Exec("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
		username, hash, time.Now().UTC().Format(time.RFC3339))
	return err
}

// upsertUser sets a user's password, creating the user if they don't exist.
// Used by the on-server admin flag -set-password.
func upsertUser(db *sql.DB, username, password string) error {
	username = strings.ToLower(strings.TrimSpace(username))
	if err := validUsername(username); err != nil {
		return err
	}
	if err := validatePassword(password); err != nil {
		return err
	}
	hash, err := bcryptHash(password)
	if err != nil {
		return err
	}
	res, err := db.Exec("UPDATE users SET password_hash = ? WHERE username = ?", hash, username)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		_, err = db.Exec("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
			username, hash, time.Now().UTC().Format(time.RFC3339))
		return err
	}
	return nil
}

func bcryptHash(password string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	return string(h), err
}

func validatePassword(password string) error {
	if password == "" {
		return errors.New("password must not be empty")
	}
	if len(password) > maxPasswordLen {
		return fmt.Errorf("password too long (max %d bytes)", maxPasswordLen)
	}
	return nil
}

// validUsername rejects names that cannot safely be a filename component:
// each account's gift log lives at progress/<username>.db, so separators or
// dot-dot would turn a login into a path traversal.
func validUsername(username string) error {
	if username == "" {
		return errors.New("username must not be empty")
	}
	if len(username) > 254 {
		return errors.New("username too long (max 254 bytes)")
	}
	if username == "." || username == ".." {
		return errors.New("username is not a valid name")
	}
	if strings.ContainsAny(username, `/\`+"\x00") {
		return errors.New("username contains invalid characters")
	}
	for _, r := range username {
		if r < 0x20 || r == 0x7f {
			return errors.New("username contains control characters")
		}
	}
	return nil
}

// verifyUser checks credentials case-insensitively and returns the canonical
// (stored) username on success, so sessions and progress files always use the
// same spelling ("Mabel" and "mabel" are the same user).
func verifyUser(db *sql.DB, username, password string) (string, bool, error) {
	var stored string
	var hash sql.NullString
	err := db.QueryRow("SELECT username, password_hash FROM users WHERE lower(username) = lower(?)",
		username).Scan(&stored, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		// Run a real bcrypt comparison against a dummy hash so response time
		// is the same whether the username exists or not.
		_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	// Google-only accounts have no password hash. Treat them as a normal
	// failed login (401), not a 500 — and burn the same bcrypt time so they
	// are indistinguishable from a wrong password.
	if !hash.Valid {
		_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return "", false, nil
	}
	if bcrypt.CompareHashAndPassword([]byte(hash.String), []byte(password)) != nil {
		return "", false, nil
	}
	return stored, true, nil
}

// sessionStore keeps active sessions in memory (home-server scale; restart = re-login).
type sessionStore struct {
	mu       sync.Mutex
	sessions map[string]session
	now      func() time.Time
}

type session struct {
	username  string
	expiresAt time.Time
}

func newSessionStore() *sessionStore {
	s := &sessionStore{sessions: make(map[string]session), now: time.Now}
	go s.pruneLoop()
	return s
}

func (s *sessionStore) pruneLoop() {
	for range time.Tick(time.Hour) {
		s.mu.Lock()
		for tok, sess := range s.sessions {
			if s.now().After(sess.expiresAt) {
				delete(s.sessions, tok)
			}
		}
		s.mu.Unlock()
	}
}

func (s *sessionStore) create(username string) (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	tok := hex.EncodeToString(buf)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.sessions) >= maxSessions {
		s.evictOldestLocked()
	}
	s.sessions[tok] = session{username: username, expiresAt: s.now().Add(sessionTTL)}
	return tok, nil
}

// evictOldestLocked drops the session expiring soonest to make room for a new
// one. Only hit at the cap; it is the difference between "one user gets logged
// out early" and "the process runs out of memory". Caller holds mu.
func (s *sessionStore) evictOldestLocked() {
	var oldestTok string
	var oldest time.Time
	first := true
	for tok, sess := range s.sessions {
		if first || sess.expiresAt.Before(oldest) {
			oldestTok, oldest, first = tok, sess.expiresAt, false
		}
	}
	if !first {
		delete(s.sessions, oldestTok)
	}
}

func (s *sessionStore) get(tok string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[tok]
	if !ok {
		return "", false
	}
	if s.now().After(sess.expiresAt) {
		delete(s.sessions, tok)
		return "", false
	}
	return sess.username, true
}

func (s *sessionStore) remove(tok string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, tok)
}

// isHTTPS reports whether the request reached the server over TLS, either
// directly or through a proxy that sets X-Forwarded-Proto (SWAG does).
func isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func (s *server) setSessionCookie(w http.ResponseWriter, r *http.Request, tok string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    tok,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		// Only mark Secure when the connection is actually HTTPS, so the
		// session also works over plain HTTP (e.g. LAN IP:port on a phone).
		Secure: s.cfg.secureCookies && isHTTPS(r),
		MaxAge: int(sessionTTL.Seconds()),
	})
}

// requireAuth wraps a handler with session verification. Every authenticated
// response is per-user data (identity, gift log), so none of it may be stored
// by a browser or an intermediary cache.
func (s *server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		c, err := r.Cookie(sessionCookie)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not logged in"})
			return
		}
		username, ok := s.sessions.get(c.Value)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "session expired"})
			return
		}
		next(w, r.WithContext(withUsername(r.Context(), username)))
	}
}

func (s *server) handleLogin(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !s.loginLimit.allow(ip) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many login attempts, try again later"})
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request"})
		return
	}
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))
	if len(req.Password) > maxPasswordLen {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password too long"})
		return
	}
	canonical, ok, err := verifyUser(s.usersDB, req.Username, req.Password)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	if !ok {
		s.loginLimit.recordFailure(ip)
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}
	s.loginLimit.reset(ip)
	tok, err := s.sessions.create(canonical)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	s.setSessionCookie(w, r, tok)
	log.Printf("login ok user=%q ip=%s", canonical, ip)
	writeJSON(w, http.StatusOK, map[string]string{"username": canonical})
}

// clientIP returns the real client IP. Only headers that the edge proxy
// OVERWRITES are trusted: Cloudflare sets CF-Connecting-IP, SWAG sets X-Real-IP.
// X-Forwarded-For is deliberately ignored — both proxies *append* to it, so its
// first hop is whatever the client sent. Trusting it let anyone mint a fresh
// rate-limit bucket (and a permanent limiter map entry) per request.
func clientIP(r *http.Request) string {
	for _, h := range []string{"CF-Connecting-IP", "X-Real-IP"} {
		if v := strings.TrimSpace(r.Header.Get(h)); v != "" {
			if ip := net.ParseIP(v); ip != nil {
				return ip.String()
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.sessions.remove(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleDeleteAccount removes the caller's account entirely: session, progress
// file, user row. Self-serve in both auth modes.
func (s *server) handleDeleteAccount(w http.ResponseWriter, r *http.Request) {
	username := usernameFrom(r.Context())
	if username == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not logged in"})
		return
	}
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.sessions.remove(c.Value)
	}
	// Progress data first: if the user row delete fails we'd rather have an
	// orphan row than orphaned personal files.
	path, perr := s.progressPath(username)
	if perr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not resolve progress data"})
		return
	}
	if err := removeProgressArtifacts(path); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not delete progress data"})
		return
	}
	res, err := s.usersDB.Exec("DELETE FROM users WHERE username = ?", username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not delete account"})
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such account"})
		return
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1})
	log.Printf("account deleted user=%q ip=%s", username, clientIP(r))
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"username": usernameFrom(r.Context())})
}
