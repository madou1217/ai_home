package proxyingress

import (
	"context"
	"net"
	"net/http"
	"net/url"
)

func (i *Ingress) newHTTPTransport() *http.Transport {
	// The upstream lease stream ignores the dial address: every stream already
	// terminates at the upstream proxy. The host is only a placeholder that
	// keeps net/http's proxy path, which writes absolute-form requests and
	// adds the configured Proxy-Authorization.
	//
	// Credentials are read per request so UpdateUpstream can swap the lease
	// token without rebuilding the transport.
	return &http.Transport{
		Proxy: func(*http.Request) (*url.URL, error) {
			credentials := i.currentCredentials()
			return &url.URL{
				Scheme: "http",
				Host:   "upstream.invalid",
				User:   url.UserPassword(credentials.Username, credentials.Password),
			}, nil
		},
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			stream, err := i.openStream(ctx)
			if err != nil {
				return nil, err
			}
			return &streamConn{stream: stream}, nil
		},
		DisableCompression:     true,
		DisableKeepAlives:      true,
		ForceAttemptHTTP2:      false,
		MaxResponseHeaderBytes: int64(i.maxHeaderBytes),
	}
}
