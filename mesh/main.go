// Command aiordie-mesh is the userspace mesh sidecar for ai-or-die. It joins a
// Tailscale tailnet entirely in userspace via tsnet (no kernel TUN, no admin,
// no system service) and reverse-proxies the tailnet listener to ai-or-die's
// local HTTP/WebSocket port. Only this one port is exposed on the mesh; the
// rest of the machine never joins. Enrollment is one-time via TS_AUTHKEY; the
// node identity persists in --statedir so the key is never needed again.
//
// stdout protocol (parsed by src/mesh-manager.js):
//   MESH-URL https://<name>      node is up and serving
//   MESH-NEEDLOGIN <url>         no/!valid key — operator must enroll
//   MESH-ERR <msg>              fatal
package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	"tailscale.com/tsnet"
)

func main() {
	port := flag.String("port", "7777", "local ai-or-die port to expose")
	host := flag.String("hostname", "aiordie", "tailnet hostname")
	dir := flag.String("statedir", "./ts-state", "persistent node state dir")
	flag.Parse()

	s := &tsnet.Server{Dir: *dir, Hostname: *host}
	// Surface the login URL exactly once instead of tsnet's default stderr spam.
	s.AuthKey = os.Getenv("TS_AUTHKEY")
	defer s.Close()

	// Bring the node up; report the enroll URL if it needs login.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if _, err := s.Up(ctx); err != nil {
		// Up blocks until authed; on timeout it's almost always missing/!key.
		fmt.Printf("MESH-NEEDLOGIN https://login.tailscale.com/admin/settings/keys\n")
		fmt.Printf("MESH-ERR %v\n", err)
		os.Exit(1)
	}

	ln, err := s.Listen("tcp", ":80")
	if err != nil {
		fmt.Printf("MESH-ERR %v\n", err)
		os.Exit(1)
	}
	target, _ := url.Parse("http://127.0.0.1:" + *port)
	rp := httputil.NewSingleHostReverseProxy(target) // handles WS upgrade via hijack

	st, _ := s.Up(ctx)
	name := *host
	if st != nil && st.Self != nil && st.Self.DNSName != "" {
		name = strings.TrimSuffix(st.Self.DNSName, ".")
	}
	fmt.Printf("MESH-URL https://%s\n", name)

	_ = http.Serve(ln, rp)
}
