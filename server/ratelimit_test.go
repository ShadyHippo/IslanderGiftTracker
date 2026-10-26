package main

import (
	"fmt"
	"testing"
	"time"
)

// fmtSprintfIP makes a distinct, plausible address per index for limiter tests.
func fmtSprintfIP(i int) string {
	return fmt.Sprintf("10.%d.%d.%d", (i>>16)&255, (i>>8)&255, i&255)
}

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

// allow() must be read-only. Before this, every distinct address that merely
// *asked* created a permanent map entry — an unauthenticated memory sink.
func TestLoginLimiterAllowDoesNotAllocate(t *testing.T) {
	l := newLoginLimiter(3, 15*time.Minute)
	for i := 0; i < 5000; i++ {
		l.allow(fmtSprintfIP(i))
	}
	l.mu.Lock()
	n := len(l.failures)
	l.mu.Unlock()
	if n != 0 {
		t.Fatalf("allow() allocated %d entries for clients that never failed", n)
	}
}

// Expired entries are deleted, not just emptied.
func TestLoginLimiterPrunesEmptyEntries(t *testing.T) {
	now := time.Now()
	l := newLoginLimiter(3, time.Minute)
	l.now = func() time.Time { return now }
	l.recordFailure("1.2.3.4")
	now = now.Add(2 * time.Minute)
	l.allow("1.2.3.4")
	l.mu.Lock()
	n := len(l.failures)
	l.mu.Unlock()
	if n != 0 {
		t.Fatalf("expired entry should be deleted, %d left", n)
	}
}

// The key cap is the backstop for a genuinely large (or spoofed) client set.
func TestLoginLimiterKeyCap(t *testing.T) {
	l := newLoginLimiter(3, time.Minute)
	for i := 0; i < limiterMaxKeys+500; i++ {
		l.recordFailure(fmtSprintfIP(i))
	}
	l.mu.Lock()
	n := len(l.failures)
	l.mu.Unlock()
	if n > limiterMaxKeys {
		t.Fatalf("limiter kept %d keys, cap is %d", n, limiterMaxKeys)
	}
}
