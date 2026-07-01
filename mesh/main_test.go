package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestResolveBackend(t *testing.T) {
	cases := []struct {
		name      string
		backend   string
		port      string
		wantErr   bool
		wantHost  string // expected resolved u.Host when no error
	}{
		{"default port → loopback", "", "7777", false, "127.0.0.1:7777"},
		{"explicit loopback v4", "http://127.0.0.1:8080", "0", false, "127.0.0.1:8080"},
		{"loopback v6", "http://[::1]:8080", "0", false, "[::1]:8080"},
		{"ipv4-mapped loopback", "http://[::ffff:127.0.0.1]:8080", "0", false, "[::ffff:127.0.0.1]:8080"},
		{"localhost normalized to 127.0.0.1", "http://localhost:9000", "0", false, "127.0.0.1:9000"},
		{"https loopback allowed", "https://127.0.0.1:8443", "0", false, "127.0.0.1:8443"},
		{"off-host private ip rejected", "http://10.0.0.5:80", "0", true, ""},
		{"0.0.0.0 rejected", "http://0.0.0.0:80", "0", true, ""},
		{"public ip rejected", "http://93.184.216.34:80", "0", true, ""},
		{"arbitrary dns rejected", "http://evil.example.com:80", "0", true, ""},
		{"non-loopback v6 rejected", "http://[2001:db8::1]:80", "0", true, ""},
		{"bad scheme rejected", "ftp://127.0.0.1:80", "0", true, ""},
		{"file scheme rejected", "file:///etc/passwd", "0", true, ""},
		{"garbage rejected", "://nope", "0", true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u, err := resolveBackend(c.backend, c.port)
			if c.wantErr {
				if err == nil {
					t.Fatalf("expected error for backend=%q, got host=%q", c.backend, u.Host)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error for backend=%q: %v", c.backend, err)
			}
			if u.Host != c.wantHost {
				t.Fatalf("backend=%q → host=%q, want %q", c.backend, u.Host, c.wantHost)
			}
		})
	}
}

func TestIsLoopbackHost(t *testing.T) {
	loop := []string{"localhost", "127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"}
	notLoop := []string{"0.0.0.0", "10.0.0.1", "192.168.1.1", "93.184.216.34", "2001:db8::1", "example.com", ""}
	for _, h := range loop {
		if !isLoopbackHost(h) {
			t.Errorf("isLoopbackHost(%q) = false, want true", h)
		}
	}
	for _, h := range notLoop {
		if isLoopbackHost(h) {
			t.Errorf("isLoopbackHost(%q) = true, want false", h)
		}
	}
}

// End-to-end through the actual reverse proxy (no tailnet): a real loopback
// backend must receive the X-Forwarded-Proto/Host the edge stamps, the app
// bearer, and the pointer-captured proto must reflect the post-TLS decision.
func TestEdgeProxyForwardsProtoHostAndAuth(t *testing.T) {
	var gotProto, gotHost, gotAuth, gotBody string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotProto = r.Header.Get("X-Forwarded-Proto")
		gotHost = r.Header.Get("X-Forwarded-Host")
		gotAuth = r.Header.Get("Authorization")
		io.WriteString(w, "backend-ok")
	}))
	defer backend.Close()

	target, _ := url.Parse(backend.URL) // 127.0.0.1 loopback
	proto := "http"                      // default before the TLS decision
	rp := newEdgeProxy(target, "node.tailnet.ts.net", &proto, "app-token")
	proto = "https" // edge decided real TLS AFTER constructing the proxy

	front := httptest.NewServer(rp)
	defer front.Close()

	res, err := http.Get(front.URL + "/app")
	if err != nil {
		t.Fatalf("proxy request failed: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	gotBody = string(b)

	if gotProto != "https" {
		t.Errorf("backend saw X-Forwarded-Proto=%q, want https (pointer-captured decision)", gotProto)
	}
	if gotHost != "node.tailnet.ts.net" {
		t.Errorf("backend saw X-Forwarded-Host=%q, want node.tailnet.ts.net", gotHost)
	}
	if gotAuth != "Bearer app-token" {
		t.Errorf("backend saw Authorization=%q, want Bearer app-token", gotAuth)
	}
	if gotBody != "backend-ok" {
		t.Errorf("proxy body=%q, want backend-ok", gotBody)
	}
}

func TestRedirectToHTTPS(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "http://anything/path?q=1", nil)
	redirectToHTTPS("node.tailnet.ts.net")(rec, req)
	if rec.Code != http.StatusPermanentRedirect {
		t.Fatalf("status=%d, want 308", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, "https://node.tailnet.ts.net/path") || !strings.Contains(loc, "q=1") {
		t.Fatalf("Location=%q, want https://node.tailnet.ts.net/path?q=1", loc)
	}
}
