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
		password_hash TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`)
	return err
}

func createUser(db *sql.DB, username, password string) error {
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
		return createUser(db, username, password)
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

func verifyUser(db *sql.DB, username, password string) (bool, error) {
	var hash string
	err := db.QueryRow("SELECT password_hash FROM users WHERE username = ?", username).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		// Run a real bcrypt comparison against a dummy hash so response time
		// is the same whether the username exists or not.
		_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return false, nil
	}
	return true, nil
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
	s.sessions[tok] = session{username: username, expiresAt: s.now().Add(sessionTTL)}
	s.mu.Unlock()
	return tok, nil
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

func (s *server) sessionCookie(w http.ResponseWriter, tok string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    tok,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   s.cfg.secureCookies,
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

// requireAuth wraps a handler with session verification.
func (s *server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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
	req.Username = strings.TrimSpace(req.Username)
	if len(req.Password) > maxPasswordLen {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password too long"})
		return
	}
	ok, err := verifyUser(s.usersDB, req.Username, req.Password)
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
	tok, err := s.sessions.create(req.Username)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	s.sessionCookie(w, tok)
	log.Printf("login ok user=%q ip=%s", req.Username, ip)
	writeJSON(w, http.StatusOK, map[string]string{"username": req.Username})
}

// clientIP returns the real client IP. Behind SWAG the server is only reachable
// from the proxy, so the first X-Forwarded-For hop is trustworthy.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			xff = xff[:i]
		}
		if xff = strings.TrimSpace(xff); xff != "" {
			return xff
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

func (s *server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"username": usernameFrom(r.Context())})
}
