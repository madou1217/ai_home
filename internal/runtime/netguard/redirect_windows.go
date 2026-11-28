//go:build windows

package netguard

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// natKey identifies one client TCP connection by its original 5-tuple.
type natKey struct {
	srcIP   [16]byte
	dstIP   [16]byte
	srcPort uint16
	dstPort uint16
}

// natMapping maps a client connection to the local relay listener.
type natMapping struct {
	relayPort  uint16
	clientIP   net.IP
	clientPort uint16
	destIP     net.IP
	destPort   uint16
}

// natTable is the per-guard redirect state. It is intentionally independent
// from packet parsing so the mapping rules can be exercised without WinDivert.
type natTable struct {
	mu       sync.Mutex
	mappings map[natKey]natMapping
	byClient map[uint16]natKey
}

func newNATTable() *natTable {
	return &natTable{
		mappings: make(map[natKey]natMapping),
		byClient: make(map[uint16]natKey),
	}
}

func (table *natTable) add(key natKey, mapping natMapping) {
	table.mu.Lock()
	defer table.mu.Unlock()
	table.mappings[key] = mapping
	table.byClient[mapping.clientPort] = key
}

func (table *natTable) lookup(key natKey) (natMapping, bool) {
	table.mu.Lock()
	defer table.mu.Unlock()
	mapping, ok := table.mappings[key]
	return mapping, ok
}

func (table *natTable) lookupClient(port uint16) (natMapping, bool) {
	table.mu.Lock()
	defer table.mu.Unlock()
	key, ok := table.byClient[port]
	if !ok {
		return natMapping{}, false
	}
	mapping, ok := table.mappings[key]
	return mapping, ok
}

func (table *natTable) remove(key natKey) {
	table.mu.Lock()
	defer table.mu.Unlock()
	if mapping, ok := table.mappings[key]; ok {
		delete(table.byClient, mapping.clientPort)
		delete(table.mappings, key)
	}
}

func (table *natTable) removeClient(port uint16) {
	table.mu.Lock()
	defer table.mu.Unlock()
	key, ok := table.byClient[port]
	if !ok {
		return
	}
	delete(table.mappings, key)
	delete(table.byClient, port)
}

// ipv4Checksum computes the RFC 1071 checksum. The caller passes the header
// with the checksum field zeroed.
func ipv4Checksum(header []byte) uint16 {
	var sum uint32
	for index := 0; index+1 < len(header); index += 2 {
		sum += uint32(binary.BigEndian.Uint16(header[index : index+2]))
	}
	if len(header)%2 == 1 {
		sum += uint32(header[len(header)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

// tcpChecksumV4 computes the TCP checksum over the IPv4 pseudo-header and the
// TCP segment. The TCP checksum field must be zeroed by the caller.
func tcpChecksumV4(srcIP, dstIP []byte, tcp []byte) uint16 {
	var sum uint32
	sum += uint32(binary.BigEndian.Uint16(srcIP[0:2]))
	sum += uint32(binary.BigEndian.Uint16(srcIP[2:4]))
	sum += uint32(binary.BigEndian.Uint16(dstIP[0:2]))
	sum += uint32(binary.BigEndian.Uint16(dstIP[2:4]))
	sum += uint32(6) // TCP protocol
	sum += uint32(len(tcp))
	for index := 0; index+1 < len(tcp); index += 2 {
		sum += uint32(binary.BigEndian.Uint16(tcp[index : index+2]))
	}
	if len(tcp)%2 == 1 {
		sum += uint32(tcp[len(tcp)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = (sum & 0xffff) + (sum >> 16)
	}
	return ^uint16(sum)
}

// redirectRelay accepts rewritten client connections and tunnels each one to
// its original destination through the instance's HTTP proxy.
type redirectRelay struct {
	listener net.Listener
	proxyURL string
	table    *natTable
}

func newRedirectRelay(proxyURL string, table *natTable) (*redirectRelay, error) {
	endpoint, err := url.Parse(strings.TrimSpace(proxyURL))
	if err != nil || endpoint.Host == "" {
		return nil, errors.New("透明重定向需要有效的代理 URL")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	return &redirectRelay{listener: listener, proxyURL: proxyURL, table: table}, nil
}

func (relay *redirectRelay) port() uint16 {
	return uint16(relay.listener.Addr().(*net.TCPAddr).Port)
}

func (relay *redirectRelay) run(ctx context.Context) {
	go func() {
		<-ctx.Done()
		_ = relay.listener.Close()
	}()
	for {
		conn, err := relay.listener.Accept()
		if err != nil {
			return
		}
		go relay.handle(conn)
	}
}

func (relay *redirectRelay) handle(client net.Conn) {
	defer client.Close()
	clientPort := uint16(client.RemoteAddr().(*net.TCPAddr).Port)
	mapping, ok := relay.table.lookupClient(clientPort)
	if !ok {
		return
	}
	target := net.JoinHostPort(mapping.destIP.String(), strconv.Itoa(int(mapping.destPort)))
	upstream, err := dialProxyConnect(relay.proxyURL, target)
	if err != nil {
		return
	}
	defer upstream.Close()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, client); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, upstream); done <- struct{}{} }()
	<-done
}

func dialProxyConnect(proxyURL, target string) (net.Conn, error) {
	endpoint, err := url.Parse(proxyURL)
	if err != nil || endpoint.Host == "" {
		return nil, errors.New("代理 URL 无效")
	}
	conn, err := net.DialTimeout("tcp", endpoint.Host, 10*time.Second)
	if err != nil {
		return nil, err
	}
	request := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n\r\n"
	if deadline, ok := conn.(interface{ SetDeadline(time.Time) error }); ok {
		_ = deadline.SetDeadline(time.Now().Add(10 * time.Second))
	}
	if _, err := conn.Write([]byte(request)); err != nil {
		conn.Close()
		return nil, err
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, &http.Request{Method: http.MethodConnect})
	if err != nil {
		conn.Close()
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		conn.Close()
		return nil, fmt.Errorf("代理 CONNECT 返回 %s", response.Status)
	}
	if deadline, ok := conn.(interface{ SetDeadline(time.Time) error }); ok {
		_ = deadline.SetDeadline(time.Time{})
	}
	return conn, nil
}
