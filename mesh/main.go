// Command aiordie-mesh is the userspace mesh sidecar for ai-or-die. It joins a
// Tailscale tailnet entirely in userspace via tsnet (no kernel TUN, no admin,
// no system service) and reverse-proxies the tailnet listener to ai-or-die's
// local HTTP/WebSocket port. Only this one port is exposed on the mesh; the
// rest of the machine never joins. Enrollment is one-time via TS_AUTHKEY; the
// node identity persists in --statedir so the key is never needed again.
//
// TLS: when the tailnet has HTTPS certificates enabled, the sidecar terminates
// real `<host>.ts.net` TLS at the edge (so the advertised https:// URL is a
// genuine browser secure context — remote mic/PWA work) and reverse-proxies to
// the loopback backend. When certs are unavailable it degrades to plain http on
// :80 and says so. The scheme is decided BEFORE the URL is advertised, never
// after, because tsnet provisions the cert lazily inside the TLS handshake — a
// post-advertise failure would otherwise hang the browser.
//
// stdout protocol (parsed by src/mesh-manager.js):
//   MESH-URL https://<name>      node is up, serving real TLS at the edge
//   MESH-URL http://<name>       node is up, but TLS certs unavailable (degraded)
//   MESH-NOCERT                  hint: enable HTTPS Certificates in the tailnet
//   MESH-NEEDLOGIN <url>         no/!valid key — operator must enroll
//   MESH-ERR <msg>               fatal
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	"tailscale.com/tsnet"
)

// version is stamped at build time via -ldflags "-X main.version=<contentHash>".
var version = "dev"

const certWaitTimeout = 20 * time.Second

func main() {
	port := flag.String("port", "7777", "local ai-or-die port to expose (loopback)")
	backend := flag.String("backend", "", "full backend URL to proxy to (overrides --port); must be loopback")
	host := flag.String("hostname", "aiordie", "tailnet hostname")
	dir := flag.String("statedir", "./ts-state", "persistent node state dir")
	showVersion := flag.Bool("version", false, "print the build version (content hash) and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	// Resolve + validate the backend target. It MUST be loopback: the sidecar is
	// a tailnet-facing reverse proxy, and pointing it off-host would expose an
	// arbitrary origin to the whole tailnet.
	target, err := resolveBackend(*backend, *port)
	if err != nil {
		fmt.Printf("MESH-ERR %v\n", err)
		os.Exit(1)
	}

	s := &tsnet.Server{Dir: *dir, Hostname: *host}
	// Surface the login URL exactly once instead of tsnet's default stderr spam.
	s.AuthKey = os.Getenv("TS_AUTHKEY")
	defer s.Close()

	// Bring the node up; report the enroll URL if it needs login.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	st, err := s.Up(ctx)
	if err != nil {
		// Up blocks until authed; on timeout it's almost always missing/!key.
		fmt.Printf("MESH-NEEDLOGIN https://login.tailscale.com/admin/settings/keys\n")
		fmt.Printf("MESH-ERR %v\n", err)
		os.Exit(1)
	}

	name := *host
	if st != nil && st.Self != nil && st.Self.DNSName != "" {
		name = strings.TrimSuffix(st.Self.DNSName, ".")
	}

	// One reverse proxy; the edge scheme it advertises to the backend is decided
	// just below and captured by reference so the X-Forwarded-Proto header is
	// always accurate. The terminal client derives ws/wss from window.location,
	// so wss works regardless; this header is hygiene for any absolute-URL or
	// redirect the app generates (no mixed content).
	edgeProto := "http"
	rp := httputil.NewSingleHostReverseProxy(target)
	origDirector := rp.Director
	rp.Director = func(r *http.Request) {
		origDirector(r)
		r.Header.Set("X-Forwarded-Proto", edgeProto)
		r.Header.Set("X-Forwarded-Host", name)
	}
	// Only relevant if a future caller points --backend at an https loopback
	// origin (e.g. a self-signed local listener). The host is already validated
	// as loopback, so skipping verification is not a trust boundary.
	if target.Scheme == "https" {
		rp.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	}

	// Decide the scheme BEFORE advertising. tsnet's ListenTLS returns a listener
	// without provisioning the cert; the ACME work (and any failure) happens
	// lazily inside the first TLS handshake. So we probe cert readiness up front
	// and only advertise https:// when we are confident the handshake will work.
	if tlsLn := tryListenTLS(ctx, s, name); tlsLn != nil {
		edgeProto = "https"
		// Best-effort :80 -> https redirect so a bare http:// hit is upgraded.
		if httpLn, e := s.Listen("tcp", ":80"); e == nil {
			go http.Serve(httpLn, redirectToHTTPS(name))
		}
		fmt.Printf("MESH-URL https://%s\n", name)
		// http.Serve only returns on failure; exit non-zero so the manager
		// (which restarts on a non-zero exit) brings the sidecar back.
		err := http.Serve(tlsLn, rp)
		fmt.Printf("MESH-ERR %v\n", err)
		os.Exit(1)
	}

	// Degraded: no usable cert. Serve plain http and say so. http://<name>.ts.net
	// is NOT a browser secure context, so remote mic/PWA will not work until the
	// operator enables HTTPS Certificates in the tailnet admin console.
	ln, err := s.Listen("tcp", ":80")
	if err != nil {
		fmt.Printf("MESH-ERR %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("MESH-NOCERT\n")
	fmt.Printf("MESH-URL http://%s\n", name)
	serveErr := http.Serve(ln, rp)
	fmt.Printf("MESH-ERR %v\n", serveErr)
	os.Exit(1)
}

// resolveBackend builds the proxy target from --backend (preferred) or --port,
// and rejects anything that is not an http(s) loopback origin.
func resolveBackend(backend, port string) (*url.URL, error) {
	raw := backend
	if raw == "" {
		raw = "http://127.0.0.1:" + port
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("invalid --backend %q: %v", raw, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("backend scheme must be http/https, got %q", u.Scheme)
	}
	if !isLoopbackHost(u.Hostname()) {
		return nil, fmt.Errorf("backend host must be loopback (127.0.0.1/::1/localhost), got %q", u.Hostname())
	}
	// Pin "localhost" to a numeric loopback so the later proxy dial cannot be
	// redirected off-host by a poisoned resolver / hosts file.
	if u.Hostname() == "localhost" {
		if p := u.Port(); p != "" {
			u.Host = "127.0.0.1:" + p
		} else {
			u.Host = "127.0.0.1"
		}
	}
	return u, nil
}

func isLoopbackHost(h string) bool {
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// tryListenTLS returns a TLS listener on :443 only when a cert for `name` looks
// obtainable; otherwise nil. It first checks the tailnet's advertised cert
// domains, then proactively warms the cert with a bounded timeout so a failure
// surfaces here (returning nil) instead of mid-handshake later.
func tryListenTLS(ctx context.Context, s *tsnet.Server, name string) net.Listener {
	lc, err := s.LocalClient()
	if err != nil {
		return nil
	}
	status, err := lc.Status(ctx)
	if err != nil || status == nil {
		return nil
	}
	eligible := false
	for _, d := range status.CertDomains {
		if d == name {
			eligible = true
			break
		}
	}
	if !eligible {
		return nil
	}
	// Proactively obtain the cert with a bounded timeout. If the tailnet says the
	// domain is eligible but issuance still fails (HTTPS not actually enabled,
	// ACME hiccup), we learn it now and fall back to http rather than hanging the
	// first browser request.
	warmCtx, cancel := context.WithTimeout(ctx, certWaitTimeout)
	defer cancel()
	if _, _, err := lc.CertPair(warmCtx, name); err != nil {
		return nil
	}
	ln, err := s.ListenTLS("tcp", ":443")
	if err != nil {
		return nil
	}
	return ln
}

func redirectToHTTPS(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u := "https://" + name + r.URL.RequestURI()
		http.Redirect(w, r, u, http.StatusPermanentRedirect)
	}
}
