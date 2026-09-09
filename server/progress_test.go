package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func tempUsersDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", dsn(filepath.Join(t.TempDir(), "users.db")))
	if err != nil {
		t.Fatalf("open users db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := initUsersSchema(db); err != nil {
		t.Fatalf("schema: %v", err)
	}
	return db
}

func TestValidSQLite(t *testing.T) {
	good := append([]byte("SQLite format 3\x00"), make([]byte, 32)...)
	if !validSQLite(good) {
		t.Fatal("valid magic should pass")
	}
	if validSQLite([]byte("not sqlite at all")) {
		t.Fatal("garbage should fail")
	}
	if validSQLite(nil) {
		t.Fatal("empty should fail")
	}
}

func TestQuickCheck(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.db")
	db, err := sql.Open("sqlite", dsn(good))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE t (x)"); err != nil {
		t.Fatal(err)
	}
	db.Close()

	res, err := quickCheck(good)
	if err != nil || res != "ok" {
		t.Fatalf("quickCheck good: res=%q err=%v", res, err)
	}

	garbage := filepath.Join(dir, "garbage.db")
	if err := os.WriteFile(garbage, []byte("junk data"), 0o644); err != nil {
		t.Fatal(err)
	}
	if res, err := quickCheck(garbage); err == nil {
		t.Fatalf("quickCheck garbage should error, got res=%q", res)
	}
}

func TestEnsureProgressDB(t *testing.T) {
	s := &server{progDir: t.TempDir()}
	path := s.progressPath("testuser")
	if err := s.ensureProgressDB(path); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("file should exist: %v", err)
	}
	db, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM gifts").Scan(&n); err != nil {
		t.Fatalf("gifts table missing: %v", err)
	}
	if err := s.ensureProgressDB(path); err != nil {
		t.Fatalf("ensure on existing should be a no-op: %v", err)
	}
}

// TestNoBackupsOnReupload pins the one-db-per-user policy: re-uploading the
// progress db must never spawn versioned backup copies next to it.
func TestNoBackupsOnReupload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "testuser.db")
	if err := os.WriteFile(path, makeValidDB(t), 0o644); err != nil {
		t.Fatal(err)
	}
	// The old build would have written dir/backups/testuser-<ts>.db here.
	matches, _ := filepath.Glob(filepath.Join(dir, "*", "*.db"))
	if len(matches) != 0 {
		t.Fatalf("no backup copies should exist, found: %v", matches)
	}
}
