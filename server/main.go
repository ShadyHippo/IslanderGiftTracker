package main

import (
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type config struct {
	port          string
	dataDir       string
	staticDir     string
	initUsers     string // "user1:pass1,user2:pass2" (password mode)
	secureCookies bool

	// AUTH_MODE selects the login door: "password" (self-hosted default,
	// zero-config) or "google" (public instances; OIDC redirect flow).
	authMode           string
	googleClientID     string
	googleClientSecret string
	googleIssuer       string // overridable so tests can point at a fake IdP
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

type server struct {
	cfg        config
	usersDB    *sql.DB
	sessions   *sessionStore
	refDir     string
	progDir    string
	loginLimit *loginLimiter
	oauth      *oauthClient // non-nil only in google mode
}

func main() {
	// Management flags: admin-only password reset (run on the server).
	setUser := flag.String("set-password", "", "username to set/reset the password for (admin, on-server)")
	pass := flag.String("password", "", "new password (used with -set-password)")
	flag.Parse()

	cfg := config{
		port:               env("PORT", "8080"),
		dataDir:            env("DATA_DIR", "./data"),
		staticDir:          env("STATIC_DIR", "../client/dist"),
		initUsers:          os.Getenv("ACNH_INIT_USERS"),
		secureCookies:      os.Getenv("SECURE_COOKIES") == "true",
		authMode:           env("AUTH_MODE", "password"),
		googleClientID:     os.Getenv("GOOGLE_CLIENT_ID"),
		googleClientSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
		googleIssuer:       env("GOOGLE_ISSUER", "https://accounts.google.com"),
	}
	if err := cfg.validate(); err != nil {
		log.Fatalf("config: %v", err)
	}

	refDir := env("REF_DIR", filepath.Join(cfg.dataDir, "ref"))
	progDir := filepath.Join(cfg.dataDir, "progress")
	for _, d := range []string{cfg.dataDir, refDir, progDir, filepath.Join(progDir, "backups")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			log.Fatalf("mkdir %s: %v", d, err)
		}
	}

	usersDB, err := sql.Open("sqlite", dsn(filepath.Join(cfg.dataDir, "users.db")))
	if err != nil {
		log.Fatalf("open users db: %v", err)
	}
	if err := initUsersSchema(usersDB); err != nil {
		log.Fatalf("init users schema: %v", err)
	}

	// Admin password reset (password mode): update-or-create and exit.
	if *setUser != "" {
		if *pass == "" {
			log.Fatal("-set-password requires -password")
		}
		if err := upsertUser(usersDB, *setUser, *pass); err != nil {
			log.Fatalf("set password: %v", err)
		}
		log.Printf("password set for user %q", *setUser)
		return
	}

	srv := &server{
		cfg:        cfg,
		usersDB:    usersDB,
		sessions:   newSessionStore(),
		refDir:     refDir,
		progDir:    progDir,
		loginLimit: newLoginLimiter(loginRateMax(), loginRateWindow()),
	}
	if cfg.authMode == "google" {
		srv.oauth = newOAuthClient(cfg)
	}

	if err := srv.bootstrapUsers(); err != nil {
		log.Fatalf("bootstrap users: %v", err)
	}

	addr := ":" + cfg.port
	httpSrv := &http.Server{Addr: addr, Handler: securityHeaders(newMux(srv), cfg.secureCookies)}
	log.Printf("acnh server listening on %s (data: %s)", addr, cfg.dataDir)
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// validate enforces mode-specific requirements at boot rather than failing
// later on the first login attempt.
func (c config) validate() error {
	switch c.authMode {
	case "password":
		return nil
	case "google":
		if c.googleClientID == "" || c.googleClientSecret == "" {
			return fmt.Errorf("AUTH_MODE=google requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET")
		}
		return nil
	default:
		return fmt.Errorf("AUTH_MODE must be \"password\" or \"google\" (got %q)", c.authMode)
	}
}

// securityHeaders stamps baseline hardening headers on every response. HSTS
// rides on SECURE_COOKIES: both only make sense once the site is served over
// public HTTPS (Cloudflare terminates TLS in front of this process).
func securityHeaders(next http.Handler, secure bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		if secure {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// newMux wires all routes; extracted so tests can build the same handler.
func newMux(s *server) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
	})
	mux.HandleFunc("GET /api/auth/config", s.handleAuthConfig)
	if s.cfg.authMode == "google" {
		mux.HandleFunc("GET /api/auth/google/start", s.handleGoogleStart)
		mux.HandleFunc("GET /api/auth/google/callback", s.handleGoogleCallback)
	} else {
		mux.HandleFunc("POST /api/login", s.handleLogin)
	}
	mux.HandleFunc("DELETE /api/account", s.requireAuth(s.handleDeleteAccount))
	mux.HandleFunc("POST /api/logout", s.requireAuth(s.handleLogout))
	mux.HandleFunc("GET /api/me", s.requireAuth(s.handleMe))
	mux.HandleFunc("GET /api/progress", s.requireAuth(s.handleGetProgress))
	mux.HandleFunc("PUT /api/progress", s.requireAuth(s.handlePutProgress))
	mux.HandleFunc("GET /api/progress/versions", s.requireAuth(s.handleProgressVersions))
	mux.HandleFunc("GET /db/manifest.json", s.handleManifest)
	mux.HandleFunc("GET /db/{filename}", s.handleRefDownload)
	mux.HandleFunc("GET /img/manifest.json", s.handleImageManifest)
	mux.HandleFunc("GET /img/images.zip", s.handleImageBundle)
	mux.HandleFunc("GET /img/{category}/{filename}", s.handleImageFile)
	mux.Handle("/", spaHandler(filepath.Clean(s.cfg.staticDir)))
	return mux
}

func loginRateMax() int {
	v, err := strconv.Atoi(env("ACNH_LOGIN_RATE_MAX", "10"))
	if err != nil || v < 1 {
		return 10
	}
	return v
}

func loginRateWindow() time.Duration {
	v, err := strconv.Atoi(env("ACNH_LOGIN_RATE_WINDOW_MIN", "15"))
	if err != nil || v < 1 {
		v = 15
	}
	return time.Duration(v) * time.Minute
}

// dsn builds a modernc.org/sqlite DSN with pragmas.
func dsn(path string) string {
	return fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)", path)
}

// bootstrapUsers creates initial users from ACNH_INIT_USERS if the table is empty.
// Password-mode only: in google mode accounts are born from verified emails.
func (s *server) bootstrapUsers() error {
	if s.cfg.initUsers == "" || s.cfg.authMode != "password" {
		return nil
	}
	var n int
	if err := s.usersDB.QueryRow("SELECT COUNT(*) FROM users").Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	for _, pair := range strings.Split(s.cfg.initUsers, ",") {
		parts := strings.SplitN(pair, ":", 2)
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			continue
		}
		if err := createUser(s.usersDB, parts[0], parts[1]); err != nil {
			return fmt.Errorf("create user %q: %w", parts[0], err)
		}
		log.Printf("created initial user %q", parts[0])
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
