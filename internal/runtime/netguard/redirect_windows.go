//go:build windows

package netguard

import (
	"encoding/binary"
	"net"
	"sync"
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
