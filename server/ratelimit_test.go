package main

import (
	"testing"
	"time"
)

func TestLoginLimiter(t *testing.T) {
	now := time.Now()
	l := newLoginLimiter(3, 15*time.Minute)
	l.now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if !l.allow("1.2.3.4") {
			t.Fatalf("attempt %d should be allowed", i+1)
		}
		l.recordFailure("1.2.3.4")
	}
	if l.allow("1.2.3.4") {
		t.Fatal("4th failure should be blocked")
	}
	// Other IPs are unaffected.
	if !l.allow("9.9.9.9") {
		t.Fatal("unrelated IP should not be blocked")
	}
	// Window expiry frees the IP.
	now = now.Add(16 * time.Minute)
	if !l.allow("1.2.3.4") {
		t.Fatal("IP should be allowed after window expiry")
	}
}

func TestLoginLimiterResetOnSuccess(t *testing.T) {
	now := time.Now()
	l := newLoginLimiter(2, 15*time.Minute)
	l.now = func() time.Time { return now }

	l.recordFailure("1.2.3.4")
	l.recordFailure("1.2.3.4")
	if l.allow("1.2.3.4") {
		t.Fatal("should be blocked after 2 failures")
	}
	l.reset("1.2.3.4")
	if !l.allow("1.2.3.4") {
		t.Fatal("successful login should clear failures")
	}
}
