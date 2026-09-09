package main

import (
	"database/sql"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

const maxUploadBytes = 64 << 20 // 64 MB

const progressTemplate = `CREATE TABLE IF NOT EXISTS gifts (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	villager TEXT NOT NULL,
	item TEXT NOT NULL,
	date TEXT NOT NULL,
	note TEXT,
	created_at TEXT NOT NULL
);`

func (s *server) progressPath(username string) string {
	return filepath.Join(s.progDir, username+".db")
}

// ensureProgressDB creates an empty progress database if none exists yet.
func (s *server) ensureProgressDB(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	db, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err := db.Exec(progressTemplate); err != nil {
		return err
	}
	return nil
}

func (s *server) handleGetProgress(w http.ResponseWriter, r *http.Request) {
	username := usernameFrom(r.Context())
	path := s.progressPath(username)
	if err := s.ensureProgressDB(path); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not create progress db"})
		return
	}
	// http.ServeFile gives Range support + correct Content-Type.
	http.ServeFile(w, r, path)
}

func (s *server) handlePutProgress(w http.ResponseWriter, r *http.Request) {
	username := usernameFrom(r.Context())
	final := s.progressPath(username)

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxUploadBytes))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "upload too large or unreadable"})
		return
	}
	if !validSQLite(body) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "not a valid sqlite database"})
		return
	}

	tmp := final + ".uploading"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not write upload"})
		return
	}
	// Integrity check via PRAGMA quick_check before accepting.
	if ok, err := quickCheck(tmp); err != nil || ok != "ok" {
		os.Remove(tmp)
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sqlite integrity check failed"})
		return
	}

	// Atomic replace: the upload already passed quick_check, so the only
	// window where data could be lost is a rename failure — and then the
	// previous file is still in place.
	if err := os.Rename(tmp, final); err != nil {
		os.Remove(tmp)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not finalize upload"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true", "username": username})
}

// validSQLite checks the SQLite magic header.
func validSQLite(b []byte) bool {
	return len(b) >= 16 && string(b[:16]) == "SQLite format 3\x00"
}

// quickCheck runs PRAGMA quick_check on a sqlite file.
func quickCheck(path string) (string, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return "", err
	}
	defer db.Close()
	var res string
	if err := db.QueryRow("PRAGMA quick_check").Scan(&res); err != nil {
		return "", err
	}
	return strings.ToLower(strings.TrimSpace(res)), nil
}
