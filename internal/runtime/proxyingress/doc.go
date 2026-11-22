// Package proxyingress provides loopback-only, authenticated HTTP and SOCKS5
// proxy listeners backed by a caller-supplied upstream lease stream.
//
// The caller supplies Dial, a factory that opens one fresh stream to the
// upstream lease endpoint for each local client connection. The upstream
// endpoint must speak the HTTP proxy protocol:
//
//   - HTTP clients are forwarded as CONNECT or absolute-form requests.
//   - SOCKS5 clients are converted into an authenticated upstream CONNECT.
//
// Credentials authenticate local clients and are also used to authenticate the
// CONNECT issued on behalf of SOCKS5 clients. URLs returned by Ingress embed
// those credentials so clients can use them directly; never write them to logs,
// error messages, or version control.
package proxyingress
