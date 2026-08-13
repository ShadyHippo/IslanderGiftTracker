package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sort"
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
	path := s.progressPath("wife")
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

func TestPruneBackups(t *testing.T) {
	dir := t.TempDir()
	s := &server{progDir: dir}
	backupDir := s.backupDir()
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxBackups+10; i++ {
		name := filepath.Join(backupDir, fmt.Sprintf("wife-20260101-%06d.db", i))
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	s.pruneBackups("wife")
	matches, _ := filepath.Glob(filepath.Join(backupDir, "wife-*.db"))
	if len(matches) != maxBackups {
		t.Fatalf("expected %d backups kept, got %d", maxBackups, len(matches))
	}
	sort.Strings(matches)
	if filepath.Base(matches[0]) != "wife-20260101-000010.db" {
		t.Fatalf("oldest backups should have been pruned first, first kept = %q", filepath.Base(matches[0]))
	}
}
