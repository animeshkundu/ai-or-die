package main

import "testing"

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
