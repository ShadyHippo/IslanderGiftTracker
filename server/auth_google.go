package main

import (
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Minimal OIDC authorization-code flow for Google sign-in, hand-rolled on the
// standard library (no x/oauth2 dependency): one provider, four endpoints.
//
//	start    GET /api/auth/google/start     -> 302 to the IdP authorize URL
//	callback GET /api/auth/google/callback  -> verify state cookie, exchange
//	                                           code, validate id_token (RS256,
//	                                           issuer/audience/expiry and a
//	                                           VERIFIED email), find-or-create
//	                                           the user, issue session cookie
//
// The issuer is injectable (GOOGLE_ISSUER) so tests run against a fake IdP.
// Signup is open: a first-time Google login IS account creation.

const oauthStateCookie = "acnh_oauth_state"

const oauthStateTTL = 10 * time.Minute

type oauthClient struct {
	cfg config

	mu       sync.Mutex
	provider *oidcProvider // discovery doc + JWKS cache, refreshed hourly
}

func newOAuthClient(cfg config) *oauthClient {
	return &oauthClient{cfg: cfg}
}

type oidcProvider struct {
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	JWKSURI               string `json:"jwks_uri"`

	keys    map[string]*rsa.PublicKey // kid -> key
	fetched time.Time
}

// providerFor returns the cached discovery doc + JWKS, refreshing after an
// hour or when a signature key id is unknown (key rotation).
func (o *oauthClient) providerFor(needKeyID string) (*oidcProvider, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	p := o.provider
	if p != nil && time.Since(p.fetched) < time.Hour && (needKeyID == "" || p.keys[needKeyID] != nil) {
		return p, nil
	}
	var disc struct {
		AuthorizationEndpoint string `json:"authorization_endpoint"`
		TokenEndpoint         string `json:"token_endpoint"`
		JWKSURI               string `json:"jwks_uri"`
	}
	if err := httpGetJSON(o.cfg.googleIssuer+"/.well-known/openid-configuration", &disc); err != nil {
		return nil, fmt.Errorf("openid discovery failed: %w", err)
	}
	if disc.AuthorizationEndpoint == "" || disc.TokenEndpoint == "" || disc.JWKSURI == "" {
		return nil, errors.New("openid discovery document incomplete")
	}
	keys, err := fetchJWKS(disc.JWKSURI)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	o.provider = &oidcProvider{
		AuthorizationEndpoint: disc.AuthorizationEndpoint,
		TokenEndpoint:         disc.TokenEndpoint,
		JWKSURI:               disc.JWKSURI,
		keys:                  keys,
		fetched:               now,
	}
	return o.provider, nil
}

func httpGetJSON(rawurl string, v any) error {
	res, err := http.Get(rawurl) //nolint:gosec — URLs come from our config/discovery, not user input
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", rawurl, res.Status)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(v)
}

func fetchJWKS(jwksURI string) (map[string]*rsa.PublicKey, error) {
	var set struct {
		Keys []struct {
			Kid string `json:"kid"`
			Kty string `json:"kty"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := httpGetJSON(jwksURI, &set); err != nil {
		return nil, fmt.Errorf("jwks fetch failed: %w", err)
	}
	keys := make(map[string]*rsa.PublicKey, len(set.Keys))
	for _, k := range set.Keys {
		if k.Kty != "RSA" || k.N == "" || k.E == "" || k.Kid == "" {
			continue
		}
		n, err := base64.RawURLEncoding.DecodeString(k.N)
		if err != nil {
			continue
		}
		e, err := base64.RawURLEncoding.DecodeString(k.E)
		if err != nil || len(e) > 4 {
			continue
		}
		eVal := 0
		for _, b := range e {
			eVal = eVal<<8 | int(b)
		}
		keys[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: eVal}
	}
	if len(keys) == 0 {
		return nil, errors.New("jwks contained no RSA keys")
	}
	return keys, nil
}

// --- state cookie -----------------------------------------------------------

// oauthState binds the browser to one in-flight login: expiry + random nonce +
// the redirect URL used at /start (the token exchange must replay it exactly).
// Signed with HMAC so it's stateless across server restarts.
type oauthState struct {
	Expires  int64  `json:"e"`
	Nonce    string `json:"r"`
	Redirect string `json:"u"`
}

func (o *oauthClient) stateKey() []byte {
	sum := sha256.Sum256([]byte(o.cfg.googleClientSecret + "|" + o.cfg.googleClientID))
	return sum[:]
}

func (o *oauthClient) signState(s oauthState) (string, error) {
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	s.Nonce = base64.RawURLEncoding.EncodeToString(nonce)
	payload, err := json.Marshal(s)
	if err != nil {
		return "", err
	}
	b64 := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, o.stateKey())
	mac.Write([]byte(b64))
	return b64 + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func (o *oauthClient) verifyState(v string) (*oauthState, error) {
	b64, sig, ok := strings.Cut(v, ".")
	if !ok {
		return nil, errors.New("malformed state")
	}
	mac := hmac.New(sha256.New, o.stateKey())
	mac.Write([]byte(b64))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(sig), []byte(want)) {
		return nil, errors.New("state signature mismatch")
	}
	raw, err := base64.RawURLEncoding.DecodeString(b64)
	if err != nil {
		return nil, err
	}
	var s oauthState
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	if time.Now().Unix() > s.Expires {
		return nil, errors.New("state expired")
	}
	return &s, nil
}

func (o *oauthClient) setStateCookie(w http.ResponseWriter, r *http.Request, value string) {
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookie,
		Value:    value,
		Path:     "/api/auth/google/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   o.cfg.secureCookies && isHTTPS(r),
		MaxAge:   int(oauthStateTTL.Seconds()),
	})
}

// redirectURL resolves where Google should send the browser back to. Prefer an
// explicit GOOGLE_REDIRECT_URL; otherwise derive from the request (Cloudflare /
// proxies preserve Host and X-Forwarded-Proto on this setup).
func (s *server) googleRedirectURL(r *http.Request) string {
	if v := env("GOOGLE_REDIRECT_URL", ""); v != "" {
		return v
	}
	scheme := "https"
	if !isHTTPS(r) {
		scheme = "http"
	}
	host := r.Host
	if fh := r.Header.Get("X-Forwarded-Host"); fh != "" {
		host = fh
	}
	return scheme + "://" + host + "/api/auth/google/callback"
}

// --- handlers ---------------------------------------------------------------

// handleAuthConfig tells the client which login door exists. Public info only
// (the client id is public by design).
func (s *server) handleAuthConfig(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	cfg := map[string]string{"mode": s.cfg.authMode}
	if s.cfg.authMode == "google" {
		cfg["clientId"] = s.cfg.googleClientID
	}
	writeJSON(w, http.StatusOK, cfg)
}

func (s *server) handleGoogleStart(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !s.loginLimit.allow(ip) {
		http.Redirect(w, r, "/?login_error="+url.QueryEscape("Too many attempts — try again later."), http.StatusFound)
		return
	}
	prov, err := s.oauth.providerFor("")
	if err != nil {
		log.Printf("google start: discovery failed: %v", err)
		http.Redirect(w, r, "/?login_error="+url.QueryEscape("Sign-in is temporarily unavailable."), http.StatusFound)
		return
	}
	redirectURL := s.googleRedirectURL(r)
	tok, err := s.oauth.signState(oauthState{
		Expires:  time.Now().Add(oauthStateTTL).Unix(),
		Redirect: redirectURL,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	s.oauth.setStateCookie(w, r, tok)

	q := url.Values{
		"client_id":     {s.cfg.googleClientID},
		"redirect_uri":  {redirectURL},
		"response_type": {"code"},
		"scope":         {"openid email profile"},
		"state":         {tok},
	}
	http.Redirect(w, r, prov.AuthorizationEndpoint+"?"+q.Encode(), http.StatusFound)
}

func (s *server) handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !s.loginLimit.allow(ip) {
		http.Redirect(w, r, "/?login_error="+url.QueryEscape("Too many attempts — try again later."), http.StatusFound)
		return
	}
	fail := func(msg string) {
		log.Printf("google callback from %s: %s", ip, msg)
		http.Redirect(w, r, "/?login_error="+url.QueryEscape(msg), http.StatusFound)
	}

	c, err := r.Cookie(oauthStateCookie)
	if err != nil {
		fail("Sign-in session lost — try again.")
		return
	}
	state, err := s.oauth.verifyState(c.Value)
	if err != nil {
		fail("Sign-in link expired — try again.")
		return
	}
	// The cookie is scoped to /api/auth/google/; expire it now either way.
	s.oauth.setStateCookie(w, r, "")

	if r.URL.Query().Get("state") != c.Value {
		fail("Sign-in could not be verified — try again.")
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		fail("Google did not approve sign-in.")
		return
	}
	prov, err := s.oauth.providerFor("")
	if err != nil {
		fail("Sign-in is temporarily unavailable.")
		return
	}

	idToken, err := exchangeCode(prov.TokenEndpoint, code, state.Redirect, s.cfg.googleClientID, s.cfg.googleClientSecret)
	if err != nil {
		fail("Could not complete sign-in with Google.")
		return
	}
	kid := jwtHeaderKid(idToken)
	prov, err = s.oauth.providerFor(kid) // refresh JWKS if the key rotated
	if err != nil {
		fail("Sign-in is temporarily unavailable.")
		return
	}
	claims, err := validateIDToken(idToken, kid, prov.keys[kid], s.cfg.googleIssuer, s.cfg.googleClientID)
	if err != nil {
		log.Printf("google id_token rejected: %v", err)
		fail("Google sign-in could not be verified.")
		return
	}
	username, err := findOrCreateGoogleUser(s.usersDB, claims.Sub, claims.Email)
	if err != nil {
		log.Printf("google account resolution sub=%q email=%q: %v", claims.Sub, claims.Email, err)
		fail("Could not create your account.")
		return
	}
	tok, err := s.sessions.create(username)
	if err != nil {
		fail("Server error — try again.")
		return
	}
	s.setSessionCookie(w, r, tok)
	s.loginLimit.reset(ip)
	log.Printf("google login ok user=%q ip=%s", username, ip)
	http.Redirect(w, r, "/", http.StatusFound)
}

// exchangeCode swaps the authorization code for tokens at the IdP token
// endpoint and returns the raw id_token JWT.
func exchangeCode(tokenEndpoint, code, redirectURI, clientID, clientSecret string) (string, error) {
	form := url.Values{
		"code":          {code},
		"client_id":     {clientID},
		"client_secret": {clientSecret},
		"redirect_uri":  {redirectURI},
		"grant_type":    {"authorization_code"},
	}
	res, err := http.PostForm(tokenEndpoint, form) //nolint:noctx — one-shot server-side call during login
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 4<<10))
		return "", fmt.Errorf("token endpoint %s: %s", res.Status, body)
	}
	var tok struct {
		IDToken string `json:"id_token"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&tok); err != nil {
		return "", err
	}
	if tok.IDToken == "" {
		return "", errors.New("token response missing id_token")
	}
	return tok.IDToken, nil
}

// --- ID token validation ----------------------------------------------------

type idClaims struct {
	Iss           string `json:"iss"`
	Aud           audience
	Sub           string `json:"sub"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Exp           int64  `json:"exp"`
}

// audience accepts both "aud": "x" and "aud": ["x","y"].
type audience []string

func (a *audience) UnmarshalJSON(b []byte) error {
	var one string
	if err := json.Unmarshal(b, &one); err == nil {
		*a = []string{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return err
	}
	*a = many
	return nil
}

func jwtHeaderKid(token string) string {
	head, _, ok := strings.Cut(token, ".")
	if !ok {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(head)
	if err != nil {
		return ""
	}
	var h struct {
		Kid string `json:"kid"`
	}
	if json.Unmarshal(raw, &h) != nil {
		return ""
	}
	return h.Kid
}

// validateIDToken checks RS256 signature against the given key plus iss/aud/
// exp, and REQUIRES a verified email — accounts link and register by email.
func validateIDToken(token, kid string, key *rsa.PublicKey, wantIss, wantAud string) (*idClaims, error) {
	if key == nil {
		return nil, fmt.Errorf("unknown signing key %q", kid)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errors.New("not a JWS compact token")
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, fmt.Errorf("bad signature encoding: %w", err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(key, crypto.SHA256, digest[:], sig) != nil {
		return nil, errors.New("signature verification failed")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, fmt.Errorf("bad payload encoding: %w", err)
	}
	var c idClaims
	if err := json.Unmarshal(payload, &c); err != nil {
		return nil, fmt.Errorf("bad claims: %w", err)
	}
	if time.Now().Add(time.Minute).Unix() > c.Exp {
		return nil, errors.New("token expired")
	}
	if c.Iss != wantIss {
		return nil, fmt.Errorf("issuer mismatch: got %q want %q", c.Iss, wantIss)
	}
	okAud := false
	for _, a := range c.Aud {
		if a == wantAud {
			okAud = true
			break
		}
	}
	if !okAud {
		return nil, fmt.Errorf("audience mismatch: got %v want %q", c.Aud, wantAud)
	}
	if c.Sub == "" || c.Email == "" {
		return nil, errors.New("missing sub/email claim")
	}
	if !c.EmailVerified {
		return nil, errors.New("email not verified by provider")
	}
	return &c, nil
}

// --- account resolution -----------------------------------------------------

// findOrCreateGoogleUser logs in by google_sub, links an existing same-email
// password account, or creates a new account whose username is the email.
func findOrCreateGoogleUser(db *sql.DB, sub, email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return "", errors.New("empty email")
	}
	var uname string
	err := db.QueryRow("SELECT username FROM users WHERE google_sub = ?", sub).Scan(&uname)
	if err == nil {
		return uname, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	// Link-by-email: the existing owner of this address proves ownership by
	// completing Google sign-in (email_verified was already enforced above).
	err = db.QueryRow("SELECT username FROM users WHERE lower(email) = ?", email).Scan(&uname)
	switch {
	case err == nil:
		if _, err := db.Exec("UPDATE users SET google_sub = ?, email = ? WHERE username = ?", sub, email, uname); err != nil {
			return "", err
		}
		return uname, nil
	case !errors.Is(err, sql.ErrNoRows):
		return "", err
	}
	// New account. The desired username is the email itself, but password-mode
	// users may already own that name — append numeric suffixes until free.
	for attempt, cand := 0, email; ; attempt++ {
		if attempt > 0 {
			cand = fmt.Sprintf("%s-%d", email, attempt)
		}
		if _, err := db.Exec(
			"INSERT INTO users (username, password_hash, google_sub, email, created_at) VALUES (?, NULL, ?, ?, ?)",
			cand, sub, email, time.Now().UTC().Format(time.RFC3339),
		); err == nil {
			log.Printf("created google account user=%q", cand)
			return cand, nil
		} else if attempt >= 50 || !strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return "", err
		}
	}
}
