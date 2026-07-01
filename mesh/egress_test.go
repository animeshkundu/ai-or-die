package main

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/types/key"
	"tailscale.com/types/views"
)

type fakeStatus struct{ st *ipnstate.Status }

func (f fakeStatus) Status(context.Context) (*ipnstate.Status, error) { return f.st, nil }

func mockStatus(peers ...*ipnstate.PeerStatus) *ipnstate.Status {
	m := map[key.NodePublic]*ipnstate.PeerStatus{}
	for _, p := range peers {
		m[key.NewNode().Public()] = p
	}
	return &ipnstate.Status{Peer: m}
}

func taggedPeer(dns, tag string) *ipnstate.PeerStatus {
	t := views.SliceOf([]string{tag})
	return &ipnstate.PeerStatus{HostName: "h", DNSName: dns, Tags: &t, Online: true}
}

func untaggedPeer(dns string) *ipnstate.PeerStatus {
	return &ipnstate.PeerStatus{HostName: "h", DNSName: dns, Online: true}
}

func TestEgressTargetAllowed(t *testing.T) {
	lc := fakeStatus{mockStatus(
		taggedPeer("peer.tail.ts.net.", "tag:aiordie"), // trailing dot, normalized away
		untaggedPeer("phone.tail.ts.net"),
	)}
	cases := []struct {
		host, port string
		want       bool
		why        string
	}{
		{"peer.tail.ts.net", "443", true, "tagged peer on 443"},
		{"peer.tail.ts.net", "7777", true, "tagged peer on 7777"},
		{"PEER.TAIL.TS.NET", "443", true, "case-insensitive DNSName match"},
		{"peer.tail.ts.net", "8080", false, "port not in {443,7777}"},
		{"peer.tail.ts.net", "22", false, "ssh port rejected"},
		{"phone.tail.ts.net", "443", false, "untagged peer rejected"},
		{"unknown.tail.ts.net", "443", false, "unknown host rejected"},
		{"peer.tail.ts.net.evil.com", "443", false, "suffix-style spoof rejected"},
		{"100.64.1.2", "443", false, "IP literal rejected"},
		{"", "443", false, "empty host rejected"},
	}
	for _, c := range cases {
		if got := egressTargetAllowed(lc, c.host, c.port); got != c.want {
			t.Errorf("egressTargetAllowed(%q,%q)=%v want %v (%s)", c.host, c.port, got, c.want, c.why)
		}
	}
}

// echoDial returns a real TCP connection to a shared in-process echo server, so a
// full CONNECT tunnel (incl. half-close via CloseWrite) can be exercised without
// a tailnet.
var (
	echoOnce sync.Once
	echoAddr string
)

func echoDial(context.Context, string, string) (net.Conn, error) {
	echoOnce.Do(func() {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return
		}
		echoAddr = ln.Addr().String()
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				go func(c net.Conn) { _, _ = io.Copy(c, c); _ = c.Close() }(c)
			}
		}()
	})
	if echoAddr == "" {
		return nil, io.ErrClosedPipe
	}
	return net.Dial("tcp", echoAddr)
}

func failDial(context.Context, string, string) (net.Conn, error) {
	return nil, io.EOF
}

func serveEgress(t *testing.T, dial dialFunc, token string) (addr string, done func()) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	lc := fakeStatus{mockStatus(taggedPeer("peer.tail.ts.net", "tag:aiordie"))}
	srv := &http.Server{Handler: egressHandler(dial, lc, token)}
	go func() { _ = srv.Serve(ln) }()
	return ln.Addr().String(), func() { _ = srv.Close(); _ = ln.Close() }
}

func rawConnect(t *testing.T, proxyAddr, target, authz string) (*bufio.Reader, net.Conn) {
	t.Helper()
	c, err := net.Dial("tcp", proxyAddr)
	if err != nil {
		t.Fatal(err)
	}
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	req := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n"
	if authz != "" {
		req += "Proxy-Authorization: " + authz + "\r\n"
	}
	req += "\r\n"
	if _, err := c.Write([]byte(req)); err != nil {
		t.Fatal(err)
	}
	return bufio.NewReader(c), c
}

func statusLine(t *testing.T, br *bufio.Reader) string {
	t.Helper()
	line, err := br.ReadString('\n')
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	return line
}

func TestEgressHandlerRejectsNonConnect(t *testing.T) {
	addr, done := serveEgress(t, echoDial, "secret")
	defer done()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(3 * time.Second))
	_, _ = c.Write([]byte("GET / HTTP/1.1\r\nHost: x\r\n\r\n"))
	line, _ := bufio.NewReader(c).ReadString('\n')
	if !strings.Contains(line, "405") {
		t.Fatalf("want 405 for GET, got %q", line)
	}
}

func TestEgressHandlerRequiresToken(t *testing.T) {
	addr, done := serveEgress(t, echoDial, "secret")
	defer done()

	br, c := rawConnect(t, addr, "peer.tail.ts.net:443", "")
	if line := statusLine(t, br); !strings.Contains(line, "407") {
		t.Fatalf("want 407 without token, got %q", line)
	}
	c.Close()

	br, c = rawConnect(t, addr, "peer.tail.ts.net:443", "Bearer nope")
	if line := statusLine(t, br); !strings.Contains(line, "407") {
		t.Fatalf("want 407 with wrong token, got %q", line)
	}
	c.Close()
}

func TestEgressHandlerRejectsForbiddenTarget(t *testing.T) {
	addr, done := serveEgress(t, echoDial, "secret")
	defer done()
	br, c := rawConnect(t, addr, "evil.example.com:443", "Bearer secret")
	defer c.Close()
	if line := statusLine(t, br); !strings.Contains(line, "403") {
		t.Fatalf("want 403 for forbidden target, got %q", line)
	}
}

func TestEgressHandlerTunnelsAllowedTarget(t *testing.T) {
	addr, done := serveEgress(t, echoDial, "secret")
	defer done()
	br, c := rawConnect(t, addr, "peer.tail.ts.net:443", "Bearer secret")
	defer c.Close()
	if line := statusLine(t, br); !strings.Contains(line, "200") {
		t.Fatalf("want 200 Connection Established, got %q", line)
	}
	// Consume the blank line terminating the CONNECT response headers.
	for {
		l, err := br.ReadString('\n')
		if err != nil {
			t.Fatalf("read header terminator: %v", err)
		}
		if strings.TrimSpace(l) == "" {
			break
		}
	}
	if _, err := c.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(br, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(buf) != "ping" {
		t.Fatalf("tunnel echo mismatch: %q", buf)
	}
}

func TestEgressHandlerBadGatewayOnDialFailure(t *testing.T) {
	addr, done := serveEgress(t, failDial, "secret")
	defer done()
	br, c := rawConnect(t, addr, "peer.tail.ts.net:443", "Bearer secret")
	defer c.Close()
	if line := statusLine(t, br); !strings.Contains(line, "502") {
		t.Fatalf("want 502 on dial failure, got %q", line)
	}
}

func TestPeerCounts(t *testing.T) {
	st := mockStatus(
		taggedPeer("a.ts.net", "tag:aiordie"),
		untaggedPeer("b.ts.net"),
		untaggedPeer("c.ts.net"),
	)
	total, tagged := peerCounts(st)
	if total != 3 || tagged != 1 {
		t.Fatalf("peerCounts=(%d,%d) want (3,1)", total, tagged)
	}
}
