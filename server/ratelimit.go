package main

import (
	"sync"
	"time"
)

// limiterMaxKeys caps how many clients the limiter will remember. Without it a
// spoofed X-Forwarded-For (or a genuinely large botnet) turns the map into an
// unbounded memory sink: every new key used to be stored forever.
const limiterMaxKeys = 4096

// loginLimiter is a per-client fixed-window limiter for *failed* attempts.
// Only failures are stored: allow() is read-only, so a client that has never
// failed costs nothing and cannot make the map grow by varying its address.
// A successful login clears the counter for that client.
type loginLimiter struct {
	mu       sync.Mutex
	max      int
	window   time.Duration
	now      func() time.Time
	failures map[string][]time.Time
}

func newLoginLimiter(max int, window time.Duration) *loginLimiter {
	return &loginLimiter{max: max, window: window, now: time.Now, failures: map[string][]time.Time{}}
}

// allow reports whether another failed attempt from ip is permitted. It does
// not mutate the map: an unknown client is allowed without allocating state.
func (l *loginLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.prune(ip)) < l.max
}

// recordFailure notes a failed login from ip.
func (l *loginLimiter) recordFailure(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	fs := l.prune(ip)
	l.failures[ip] = append(fs, l.now())
	if len(l.failures) > limiterMaxKeys {
		l.evictOldest()
	}
}

// reset clears the failure history for ip (on successful login).
func (l *loginLimiter) reset(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failures, ip)
}

// prune drops failures outside the window and returns the rest. Empty entries
// are deleted outright so an attacker cycling addresses cannot pin memory with
// stale-but-present keys. Caller holds mu.
func (l *loginLimiter) prune(ip string) []time.Time {
	fs, ok := l.failures[ip]
	if !ok {
		return nil
	}
	cut := l.now().Add(-l.window)
	i := 0
	for i < len(fs) && !fs[i].After(cut) {
		i++
	}
	fs = fs[i:]
	if len(fs) == 0 {
		delete(l.failures, ip)
		return nil
	}
	l.failures[ip] = fs
	return fs
}

// evictOldest drops the entry whose most recent failure is the oldest. This is
// a safety valve for the cap above, not normal operation. Caller holds mu.
func (l *loginLimiter) evictOldest() {
	var oldestIP string
	var oldest time.Time
	first := true
	for ip, fs := range l.failures {
		var newest time.Time
		if len(fs) > 0 {
			newest = fs[len(fs)-1]
		}
		if first || newest.Before(oldest) {
			oldestIP, oldest, first = ip, newest, false
		}
	}
	if !first {
		delete(l.failures, oldestIP)
	}
}
