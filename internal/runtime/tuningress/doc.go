// Package tuningress renders and supervises a sing-box TUN ingress that
// forwards operating-system traffic to an already-running local authenticated
// HTTP proxy ingress (the endpoint exposed by `aih proxy serve`).
//
// The package deliberately separates three kinds of work:
//
//   - Render is pure: it validates Options and produces a sing-box JSON
//     configuration. It never touches the network, routes, or processes.
//   - Check is a dry run: it writes the generated configuration to a
//     temporary 0600 file and asks sing-box to validate it. sing-box does not
//     create a TUN interface while checking, so Check is safe without root.
//   - Start owns a sing-box child process. It requires an explicit binary
//     path, Options.AllowStart, and administrator/root privileges.
//
// TUN mode is an explicit network-layer takeover, never an automatic fallback.
// Creating the interface and installing routes changes where all system
// traffic goes; callers must ask the user before invoking Start. Nothing in
// this package elevates privileges by itself: when the process is not
// administrator/root, Start returns ErrPrivilegeRequired instead of trying
// sudo, osascript, UAC, or any other silent elevation mechanism.
//
// Multiple TUN owners cannot share the same routes. If Clash Verge, a mihomo
// TUN instance, another VPN, or any external TUN owner is active, starting
// this ingress competes for the default route and may break the existing
// tunnel. This package does not detect or stop external TUN owners. The
// integrating command must check for that ownership conflict, report it to the
// user, and leave the external tunnel alone unless the user explicitly chooses
// to replace it.
//
// Security notes: the rendered configuration contains the local proxy
// credentials. Render returns them to the caller and Start stores them only in
// a 0700 temporary directory as a 0600 file that is removed when the process
// exits. Error texts are redacted so credentials never appear in returned
// errors or sing-box check output.
//
// Transport limitation: a plain HTTP proxy carries TCP through CONNECT. This
// ingress routes every non-DNS flow to the HTTP outbound, so UDP traffic that
// is not DNS cannot traverse it. DNS is intercepted by sing-box and resolved
// through the direct outbound.
//
// The generated configuration uses the sing-box 1.12+ DNS server object format
// and route.default_domain_resolver. It was validated with sing-box 1.13.19;
// older sing-box releases reject this shape.
package tuningress
