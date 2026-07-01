// Command ai-or-die-mesh is the userspace mesh sidecar for ai-or-die. It joins a
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
//   MESH-PEERS {"self":...,"peers":[...]} tagged fleet peers snapshot
//   MESH-EGRESS http://127.0.0.1:<port> <token>  loopback CONNECT proxy for a
//                                same-box conductor to reach tagged tailnet peers
//   MESH-UNTAGGED <selfTagged> <total> <tagged>  tailnet peers exist but none are
//                                tagged tag:aiordie — discovery will stay empty
//   MESH-NEEDLOGIN <url>         no/!valid key — operator must enroll
//   MESH-ERR <msg>               fatal
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

// version is stamped at build time via -ldflags "-X main.version=<contentHash>".
var version = "dev"

const (
	certWaitTimeout   = 20 * time.Second
	meshPeersInterval = 20 * time.Second
	meshPeersMaxPeers = 512
	meshPeerTag       = "tag:aiordie"
)

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

	proxyBearer := os.Getenv("AIORDIE_PROXY_BEARER")

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

	if lc, err := s.LocalClient(); err == nil {
		go emitMeshPeersLoop(context.Background(), lc)
		// Loopback egress: lets a same-box conductor (github-router) reach tagged
		// tailnet peers over WireGuard without the host OS joining the tailnet.
		// Best-effort — a failure here never blocks serving.
		startEgressProxy(s, lc)
	}

	name := *host
	if st != nil && st.Self != nil && st.Self.DNSName != "" {
		name = strings.TrimSuffix(st.Self.DNSName, ".")
	}

	// One reverse proxy; the edge scheme it advertises to the backend is decided
	// just below and captured by pointer so the X-Forwarded-Proto header is
	// always accurate. The terminal client derives ws/wss from window.location,
	// so wss works regardless; this header is hygiene for any absolute-URL or
	// redirect the app generates (no mixed content).
	edgeProto := "http"
	rp := newEdgeProxy(target, name, &edgeProto, proxyBearer)

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

type statusClient interface {
	Status(context.Context) (*ipnstate.Status, error)
}

type meshPeersSnapshot struct {
	Self  meshPeerSelf `json:"self"`
	Peers []meshPeer   `json:"peers"`
}

type meshPeerSelf struct {
	Hostname string `json:"hostname"`
	DNSName  string `json:"dnsName"`
}

type meshPeer struct {
	Hostname string `json:"hostname"`
	DNSName  string `json:"dnsName"`
	Online   bool   `json:"online"`
}

func emitMeshPeersLoop(ctx context.Context, lc statusClient) {
	emitMeshPeers(ctx, lc)
	ticker := time.NewTicker(meshPeersInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			emitMeshPeers(ctx, lc)
		}
	}
}

func emitMeshPeers(ctx context.Context, lc statusClient) {
	status, err := lc.Status(ctx)
	if err != nil || status == nil {
		return
	}
	line := meshPeersFromStatus(status)
	b, err := json.Marshal(line)
	if err != nil {
		return
	}
	fmt.Printf("MESH-PEERS %s\n", b)

	// Diagnostic: tailnet peers exist but none are tagged tag:aiordie, so the
	// snapshot above is empty and fleet discovery will surface nothing. Emit a
	// machine-parseable line the manager turns into an actionable hint — the
	// silent-empty-peers state is the exact failure this whole path guards against.
	total, tagged := peerCounts(status)
	if total > 0 && tagged == 0 {
		selfTagged := status.Self != nil && peerHasTag(status.Self, meshPeerTag)
		fmt.Printf("MESH-UNTAGGED %t %d %d\n", selfTagged, total, tagged)
	}
}

func peerCounts(status *ipnstate.Status) (total, tagged int) {
	for _, ps := range status.Peer {
		if ps == nil {
			continue
		}
		total++
		if peerHasTag(ps, meshPeerTag) {
			tagged++
		}
	}
	return total, tagged
}

func meshPeersFromStatus(status *ipnstate.Status) meshPeersSnapshot {
	var self meshPeerSelf
	if status.Self != nil {
		self = meshPeerSelf{Hostname: status.Self.HostName, DNSName: normalizeDNSName(status.Self.DNSName)}
	}

	peers := make([]meshPeer, 0)
	for _, ps := range status.Peer {
		if ps == nil || !peerHasTag(ps, meshPeerTag) {
			continue
		}
		peers = append(peers, meshPeer{Hostname: ps.HostName, DNSName: normalizeDNSName(ps.DNSName), Online: ps.Online})
	}
	sort.Slice(peers, func(i, j int) bool {
		if peers[i].DNSName != peers[j].DNSName {
			return peers[i].DNSName < peers[j].DNSName
		}
		return peers[i].Hostname < peers[j].Hostname
	})
	if len(peers) > meshPeersMaxPeers {
		peers = peers[:meshPeersMaxPeers]
	}
	return meshPeersSnapshot{Self: self, Peers: peers}
}

func peerHasTag(ps *ipnstate.PeerStatus, tag string) bool {
	if ps.Tags == nil {
		return false
	}
	for i := 0; i < ps.Tags.Len(); i++ {
		if ps.Tags.At(i) == tag {
			return true
		}
	}
	return false
}

func normalizeDNSName(s string) string {
	return strings.ToLower(strings.TrimSuffix(s, "."))
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

// newEdgeProxy builds the reverse proxy to the loopback backend. It stamps
// X-Forwarded-Proto (read through *proto, set after the TLS decision) and
// X-Forwarded-Host so the app never emits mixed-content links. For an https
// loopback backend (a future self-signed local listener) it skips verification —
// the host is already validated as loopback, so this is not a trust boundary.
func newEdgeProxy(target *url.URL, name string, proto *string, proxyBearer string) *httputil.ReverseProxy {
	rp := httputil.NewSingleHostReverseProxy(target)
	orig := rp.Director
	rp.Director = func(r *http.Request) {
		orig(r)
		r.Header.Set("X-Forwarded-Proto", *proto)
		r.Header.Set("X-Forwarded-Host", name)
		// Authenticate tailnet->loopback traffic to the app's bearer middleware.
		// Set REPLACES any client-supplied Authorization (no spoofing). When no
		// token is configured, DELETE a client-supplied Authorization so a tailnet
		// caller can never smuggle one through to the loopback app.
		if proxyBearer != "" {
			r.Header.Set("Authorization", "Bearer "+proxyBearer)
		} else {
			r.Header.Del("Authorization")
		}
	}
	if target.Scheme == "https" {
		rp.Transport = &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}
	}
	return rp
}

// startEgressProxy stands up a loopback HTTP CONNECT proxy so a same-box conductor
// process (github-router) can reach TAGGED tailnet peers over the sidecar's
// in-process WireGuard — the host OS never joins the tailnet. It is bound to
// loopback, gated by a random per-process bearer, and restricted to tagged
// .ts.net peers on the served ports, so a stray local process can neither turn it
// into a generic tailnet egress nor learn the token off the wire. The endpoint +
// token are announced via MESH-EGRESS for the manager to persist (0600).
// Best-effort: any failure here never blocks serving.
func startEgressProxy(s *tsnet.Server, lc statusClient) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return
	}
	token, err := randToken()
	if err != nil {
		_ = ln.Close()
		return
	}
	fmt.Printf("MESH-EGRESS http://%s %s\n", ln.Addr().String(), token)
	srv := &http.Server{Handler: egressHandler(s.Dial, lc, token)}
	go func() { _ = srv.Serve(ln) }()
}

// dialFunc dials a tailnet address (tsnet.Server.Dial); injectable for tests.
type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

func egressHandler(dial dialFunc, lc statusClient, token string) http.Handler {
	want := "Bearer " + token
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "only CONNECT is supported", http.StatusMethodNotAllowed)
			return
		}
		// Constant-time bearer check on the proxy hop so a stray local process
		// cannot use the tailnet egress without the per-process token.
		got := r.Header.Get("Proxy-Authorization")
		if subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
			w.Header().Set("Proxy-Authenticate", "Bearer")
			http.Error(w, "proxy authorization required", http.StatusProxyAuthRequired)
			return
		}
		host, port, err := net.SplitHostPort(r.Host)
		if err != nil {
			http.Error(w, "bad CONNECT target", http.StatusBadRequest)
			return
		}
		if !egressTargetAllowed(lc, host, port) {
			http.Error(w, "forbidden CONNECT target", http.StatusForbidden)
			return
		}
		upstream, err := dial(r.Context(), "tcp", net.JoinHostPort(host, port))
		if err != nil {
			http.Error(w, "upstream dial failed", http.StatusBadGateway)
			return
		}
		hj, ok := w.(http.Hijacker)
		if !ok {
			_ = upstream.Close()
			http.Error(w, "hijack unsupported", http.StatusInternalServerError)
			return
		}
		clientConn, _, err := hj.Hijack()
		if err != nil {
			_ = upstream.Close()
			return
		}
		_, _ = clientConn.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n"))
		// Splice both directions. Half-close each write end on its own EOF (so a
		// one-way FIN — e.g. an HTTP/1.1 request with Connection: close — does not
		// truncate the reply mid-flight), then fully close once BOTH directions
		// have drained. net.Pipe and other non-TCP conns lack CloseWrite; the type
		// assertion simply skips the half-close for them.
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, _ = io.Copy(upstream, clientConn)
			if cw, ok := upstream.(interface{ CloseWrite() error }); ok {
				_ = cw.CloseWrite()
			}
		}()
		go func() {
			defer wg.Done()
			_, _ = io.Copy(clientConn, upstream)
			if cw, ok := clientConn.(interface{ CloseWrite() error }); ok {
				_ = cw.CloseWrite()
			}
		}()
		wg.Wait()
		_ = clientConn.Close()
		_ = upstream.Close()
	})
}

// egressTargetAllowed permits CONNECT only to a TAGGED same-tailnet .ts.net peer
// (exact DNSName match, never a suffix) on a served port, and rejects IP-literal
// targets — so the loopback proxy can never be turned into a generic tailnet
// egress, preserving the ACL's instance-isolation posture.
func egressTargetAllowed(lc statusClient, host, port string) bool {
	if port != "443" && port != "7777" {
		return false
	}
	if net.ParseIP(host) != nil {
		return false // no raw IPs — only MagicDNS names bound to a known tagged peer
	}
	want := normalizeDNSName(host)
	if want == "" {
		return false
	}
	status, err := lc.Status(context.Background())
	if err != nil || status == nil {
		return false
	}
	for _, ps := range status.Peer {
		if ps == nil || !peerHasTag(ps, meshPeerTag) {
			continue
		}
		if normalizeDNSName(ps.DNSName) == want {
			return true
		}
	}
	return false
}

func randToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
