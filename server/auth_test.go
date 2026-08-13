package main

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestCreateAndVerifyUser(t *testing.T) {
	db := tempUsersDB(t)
	if err := createUser(db, "wife", "s3cret"); err != nil {
		t.Fatalf("createUser: %v", err)
	}
	if ok, err := verifyUser(db, "wife", "s3cret"); err != nil || !ok {
		t.Fatalf("verify correct password: ok=%v err=%v", ok, err)
	}
	if ok, err := verifyUser(db, "wife", "wrong"); err != nil || ok {
		t.Fatalf("verify wrong password: ok=%v err=%v (want false, nil)", ok, err)
	}
	if ok, err := verifyUser(db, "nobody", "s3cret"); err != nil || ok {
		t.Fatalf("verify missing user: ok=%v err=%v (want false, nil)", ok, err)
	}
}

func TestUpsertUser(t *testing.T) {
	db := tempUsersDB(t)
	if err := upsertUser(db, "wife", "first"); err != nil {
		t.Fatalf("upsert create: %v", err)
	}
	if err := upsertUser(db, "wife", "second"); err != nil {
		t.Fatalf("upsert update: %v", err)
	}
	if ok, _ := verifyUser(db, "wife", "second"); !ok {
		t.Fatal("expected updated password to verify")
	}
	if ok, _ := verifyUser(db, "wife", "first"); ok {
		t.Fatal("old password should no longer verify")
	}
}

func TestPasswordTooLong(t *testing.T) {
	db := tempUsersDB(t)
	long := strings.Repeat("x", 80)
	if err := createUser(db, "wife", long); err == nil {
		t.Fatal("createUser should reject >64-byte password")
	}
	if err := upsertUser(db, "wife", long); err == nil {
		t.Fatal("upsertUser should reject >64-byte password")
	}
	if err := createUser(db, "wife", ""); err == nil {
		t.Fatal("createUser should reject empty password")
	}
	// A 64-byte password is the limit and must still work.
	exact := strings.Repeat("y", maxPasswordLen)
	if err := createUser(db, "wife", exact); err != nil {
		t.Fatalf("64-byte password should be accepted: %v", err)
	}
	if ok, err := verifyUser(db, "wife", exact); err != nil || !ok {
		t.Fatalf("64-byte password should verify: ok=%v err=%v", ok, err)
	}
}

func TestVerifyMissingUserIsMismatch(t *testing.T) {
	db := tempUsersDB(t)
	if err := createUser(db, "wife", "s3cret"); err != nil {
		t.Fatal(err)
	}
	// Same result shape as a wrong password for an existing user:
	// false, nil — never an error, never ok.
	ok, err := verifyUser(db, "nobody", "s3cret")
	if ok || err != nil {
		t.Fatalf("missing user: ok=%v err=%v (want false, nil)", ok, err)
	}
	ok, err = verifyUser(db, "nobody", "")
	if ok || err != nil {
		t.Fatalf("missing user, empty pw: ok=%v err=%v (want false, nil)", ok, err)
	}
}

func TestSessionStoreLifecycle(t *testing.T) {
	now := time.Now()
	s := newSessionStore()
	s.now = func() time.Time { return now }

	tok, err := s.create("wife")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if u, ok := s.get(tok); !ok || u != "wife" {
		t.Fatalf("get after create: u=%q ok=%v", u, ok)
	}
	// Not expired yet.
	now = now.Add(sessionTTL - time.Minute)
	if _, ok := s.get(tok); !ok {
		t.Fatal("session should still be valid before expiry")
	}
	// Past expiry.
	now = now.Add(2 * time.Minute)
	if _, ok := s.get(tok); ok {
		t.Fatal("session should be invalid after expiry")
	}
	// Removal.
	tok2, _ := s.create("hippo")
	s.remove(tok2)
	if _, ok := s.get(tok2); ok {
		t.Fatal("removed session should be gone")
	}
	if _, ok := s.get("bogus"); ok {
		t.Fatal("bogus token should not resolve")
	}
}

func TestClientIP(t *testing.T) {
	r := &http.Request{RemoteAddr: "192.168.1.50:5555"}
	if got := clientIP(r); got != "192.168.1.50" {
		t.Fatalf("no XFF: got %q", got)
	}
	r.Header = http.Header{}
	r.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")
	if got := clientIP(r); got != "203.0.113.7" {
		t.Fatalf("with XFF: got %q", got)
	}
}
