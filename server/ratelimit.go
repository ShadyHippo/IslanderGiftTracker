package main

import (
	"sync"
	"time"
)

// loginLimiter is a per-IP fixed-window limiter for failed login attempts.
// A successful login clears the counter for that IP.
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

// allow reports whether another failed attempt from ip is permitted.
func (l *loginLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	fs := l.prune(ip)
	return len(fs) < l.max
}

// recordFailure notes a failed login from ip.
func (l *loginLimiter) recordFailure(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	fs := l.prune(ip)
	l.failures[ip] = append(fs, l.now())
}

// reset clears the failure history for ip (on successful login).
func (l *loginLimiter) reset(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.failures, ip)
}

// prune drops failures outside the window and returns the rest. Caller holds mu.
func (l *loginLimiter) prune(ip string) []time.Time {
	cut := l.now().Add(-l.window)
	fs := l.failures[ip]
	i := 0
	for i < len(fs) && !fs[i].After(cut) {
		i++
	}
	fs = fs[i:]
	l.failures[ip] = fs
	return fs
}
