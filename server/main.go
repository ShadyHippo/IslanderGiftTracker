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
	initUsers     string // "user1:pass1,user2:pass2"
	secureCookies bool
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
}

func main() {
	// Management flags: admin-only password reset (run on the server).
	setUser := flag.String("set-password", "", "username to set/reset the password for (admin, on-server)")
	pass := flag.String("password", "", "new password (used with -set-password)")
	flag.Parse()

	cfg := config{
		port:          env("PORT", "8080"),
		dataDir:       env("DATA_DIR", "./data"),
		staticDir:     env("STATIC_DIR", "../client/dist"),
		initUsers:     os.Getenv("ACNH_INIT_USERS"),
		secureCookies: os.Getenv("SECURE_COOKIES") == "true",
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

	// Admin password reset: update-or-create the user and exit.
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

	if err := srv.bootstrapUsers(); err != nil {
		log.Fatalf("bootstrap users: %v", err)
	}

	addr := ":" + cfg.port
	httpSrv := &http.Server{Addr: addr, Handler: newMux(srv)}
	log.Printf("acnh server listening on %s (data: %s)", addr, cfg.dataDir)
	if err := httpSrv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// newMux wires all routes; extracted so tests can build the same handler.
func newMux(s *server) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.requireAuth(s.handleLogout))
	mux.HandleFunc("GET /api/me", s.requireAuth(s.handleMe))
	mux.HandleFunc("GET /api/progress", s.requireAuth(s.handleGetProgress))
	mux.HandleFunc("PUT /api/progress", s.requireAuth(s.handlePutProgress))
	mux.HandleFunc("GET /api/progress/versions", s.requireAuth(s.handleProgressVersions))
	mux.HandleFunc("GET /db/manifest.json", s.handleManifest)
	mux.HandleFunc("GET /db/{filename}", s.handleRefDownload)
	mux.HandleFunc("GET /img/manifest.json", s.handleImageManifest)
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
func (s *server) bootstrapUsers() error {
	if s.cfg.initUsers == "" {
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
