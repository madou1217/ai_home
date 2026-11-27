package proxyingress

import (
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var hopByHopHeaders = []string{
	"Connection",
	"Proxy-Connection",
	"Keep-Alive",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"Te",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

func (i *Ingress) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	if !i.allowAnonymous && !authorizedHeader(request.Header, i.currentAuthorizationValue()) {
		writer.Header().Set("Proxy-Authenticate", `Basic realm="aih-ingress"`)
		writer.Header().Set("Connection", "close")
		http.Error(writer, "proxy authentication required", http.StatusProxyAuthRequired)
		return
	}
	if request.Method == http.MethodConnect {
		i.serveConnect(writer, request)
		return
	}
	i.serveForward(writer, request)
}

func (i *Ingress) serveForward(writer http.ResponseWriter, request *http.Request) {
	if request.URL == nil || !strings.EqualFold(request.URL.Scheme, "http") || request.URL.Host == "" || request.URL.User != nil {
		writer.Header().Set("Connection", "close")
		http.Error(writer, "absolute-form http request required", http.StatusBadRequest)
		return
	}
	outbound := request.Clone(request.Context())
	outbound.RequestURI = ""
	removeHopByHop(outbound.Header)
	outbound.Header.Del("Proxy-Authorization")
	outbound.Header.Del("Proxy-Connection")

	response, err := i.httpTransport.RoundTrip(outbound)
	if err != nil {
		writer.Header().Set("Connection", "close")
		http.Error(writer, "upstream proxy unavailable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusProxyAuthRequired {
		writer.Header().Set("Connection", "close")
		http.Error(writer, "upstream proxy rejected credentials", http.StatusBadGateway)
		return
	}

	removeHopByHop(response.Header)
	for key, values := range response.Header {
		for _, value := range values {
			writer.Header().Add(key, value)
		}
	}
	writer.WriteHeader(response.StatusCode)
	if flusher, ok := writer.(http.Flusher); ok {
		flusher.Flush()
	}
	_, _ = io.Copy(writer, response.Body)
}

func (i *Ingress) serveConnect(writer http.ResponseWriter, request *http.Request) {
	if !validConnectAuthority(request.Host) {
		writer.Header().Set("Connection", "close")
		http.Error(writer, "unsupported CONNECT authority", http.StatusBadRequest)
		return
	}
	stream, err := i.openStream(request.Context())
	if err != nil {
		writer.Header().Set("Connection", "close")
		http.Error(writer, "upstream proxy unavailable", http.StatusBadGateway)
		return
	}
	defer stream.Close()

	client, buffered, err := http.NewResponseController(writer).Hijack()
	if err != nil {
		return
	}
	defer client.Close()

	outbound := request.Clone(request.Context())
	removeHopByHop(outbound.Header)
	outbound.Header.Set("Proxy-Authorization", i.currentAuthorization())
	outbound.Body = http.NoBody
	outbound.ContentLength = 0
	outbound.TransferEncoding = nil
	outbound.Header.Del("Content-Length")
	outbound.Close = false

	// Clear the server's header deadline; tunnels may stay open for hours.
	_ = client.SetDeadline(time.Time{})

	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(client, stream)
		done <- struct{}{}
	}()
	if err = outbound.WriteProxy(stream); err != nil {
		_ = client.Close()
		_ = stream.Close()
		<-done
		return
	}
	go func() {
		_, _ = io.Copy(stream, buffered.Reader)
		done <- struct{}{}
	}()
	<-done
	_ = client.Close()
	_ = stream.Close()
	<-done
}

func validConnectAuthority(authority string) bool {
	if authority == "" || len(authority) > 512 {
		return false
	}
	if strings.ContainsAny(authority, "\x00\r\n /@") {
		return false
	}
	host, port, err := net.SplitHostPort(authority)
	if err != nil || host == "" {
		return false
	}
	number, err := strconv.Atoi(port)
	return err == nil && number > 0 && number <= 65535
}

func removeHopByHop(header http.Header) {
	for _, value := range header.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if token = strings.TrimSpace(token); token != "" {
				header.Del(token)
			}
		}
	}
	for _, key := range hopByHopHeaders {
		header.Del(key)
	}
}
