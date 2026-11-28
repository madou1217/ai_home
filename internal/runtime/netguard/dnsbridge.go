package netguard

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// DNSBridge is a local DNS-over-HTTPS forwarder. It is the building block for
// the "doh_bridge" DNS mode: the instance sends plain DNS to a loopback port,
// the bridge forwards the raw query to a DoH endpoint through the instance's
// proxy, and the answer never leaves through a local resolver.
type DoHBridge struct {
	listener  net.PacketConn
	client    *http.Client
	endpoint  string
	closeOnce sync.Once
}

// NewDNSBridge starts a loopback UDP DNS listener.
//
// proxyURL is the instance proxy (HTTP CONNECT); dohURL must be an https URL.
func NewDoHBridge(proxyURL, dohURL string) (*DoHBridge, error) {
	proxy, err := url.Parse(proxyURL)
	if err != nil || proxy.Host == "" {
		return nil, errors.New("DNS 桥需要有效的代理 URL")
	}
	endpoint, err := url.Parse(dohURL)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" {
		return nil, errors.New("DNS 桥需要有效的 HTTPS DoH 地址")
	}
	listener, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{Proxy: http.ProxyURL(proxy)}
	bridge := &DoHBridge{
		listener: listener,
		client:   &http.Client{Transport: transport, Timeout: 10 * time.Second},
		endpoint: endpoint.String(),
	}
	go bridge.serve()
	return bridge, nil
}

// Addr returns the loopback address applications should use as their resolver.
func (bridge *DoHBridge) Addr() string {
	return bridge.listener.LocalAddr().String()
}

func (bridge *DoHBridge) serve() {
	buffer := make([]byte, 65535)
	for {
		count, peer, err := bridge.listener.ReadFrom(buffer)
		if err != nil {
			return
		}
		query := append([]byte(nil), buffer[:count]...)
		go func() {
			answer, err := bridge.exchange(query)
			if err != nil {
				return
			}
			_, _ = bridge.listener.WriteTo(answer, peer)
		}()
	}
}

func (bridge *DoHBridge) exchange(query []byte) ([]byte, error) {
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, bridge.endpoint, bytes.NewReader(query))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/dns-message")
	request.Header.Set("Accept", "application/dns-message")
	response, err := bridge.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("DoH 返回 " + response.Status)
	}
	return io.ReadAll(io.LimitReader(response.Body, 65535))
}

// Close stops the listener.
func (bridge *DoHBridge) Close() error {
	if bridge == nil {
		return nil
	}
	var err error
	bridge.closeOnce.Do(func() {
		err = bridge.listener.Close()
	})
	return err
}
