package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// spaHandler serves the built PWA from disk with client-side routing fallback
// to index.html. If the static dir doesn't exist yet (client not built), it
// returns a friendly placeholder so the API stays testable.
func spaHandler(dir string) http.Handler {
	if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/db/") {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("<!doctype html><title>acnh</title><p>PWA not built yet — run <code>make client-build</code>. API is live.</p>"))
		})
	}
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(dir, filepath.Clean(r.URL.Path))
		// SPA fallback: unknown routes serve index.html (unless the path has a file extension).
		if st, err := os.Stat(path); err != nil || st.IsDir() {
			if filepath.Ext(r.URL.Path) == "" {
				http.ServeFile(w, r, filepath.Join(dir, "index.html"))
				return
			}
		}
		fs.ServeHTTP(w, r)
	})
}
