//go:build windows

package netguard

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"os"
	"strconv"
	"unsafe"
)

func transparentEnabled() bool {
	return os.Getenv("AIH_NETGUARD_TRANSPARENT") == "1"
}

// startTransparent initializes the NAT table and relay, then opens the
// inbound loopback handle used for the reverse rewrite.
func (guard *WinDivertGuard) startTransparent(ctx context.Context) error {
	if guard == nil || guard.options.ProxyURL == "" {
		return nil
	}
	guard.nat = newNATTable()
	relay, err := newRedirectRelay(guard.options.ProxyURL, guard.nat)
	if err != nil {
		return err
	}
	guard.relay = relay
	go relay.run(ctx)
	filter := fmt.Sprintf("inbound and tcp and loopback and tcp.SrcPort == %d", relay.port())
	filterPtr, err := syscallBytePtr(filter)
	if err != nil {
		return err
	}
	handle, _, callErr := winDivertOpenProc.Call(uintptr(unsafe.Pointer(filterPtr)), uintptr(winDivertLayerNetwork), 0, 0)
	if handle == invalidHandle || handle == 0 {
		return fmt.Errorf("打开透明回程句柄失败: %v", callErr)
	}
	guard.inbound = handle
	go guard.drainInbound(handle)
	return nil
}

func syscallBytePtr(value string) (*byte, error) {
	bytes := append([]byte(value), 0)
	return &bytes[0], nil
}

// rewriteOutbound rewrites an IPv4 TCP packet from the protected tree to the
// loopback relay. It returns nil when the packet is not transparent traffic.
func (guard *WinDivertGuard) rewriteOutbound(packet []byte) []byte {
	if guard == nil || guard.nat == nil || guard.relay == nil {
		return nil
	}
	protocol, srcPort, ok := transportSource(packet)
	if !ok || protocol != 6 || len(packet) < 20 || packet[0]>>4 != 4 {
		return nil
	}
	ihl := int(packet[0]&0x0f) * 4
	tcp := packet[ihl:]
	if len(tcp) < 20 {
		return nil
	}
	flags := binary.BigEndian.Uint16(tcp[12:14])
	if flags&0x02 == 0 { // not SYN
		key := makeKey(packet[12:16], packet[16:20], srcPort, binary.BigEndian.Uint16(tcp[2:4]))
		if _, exists := guard.nat.lookup(key); !exists {
			return nil
		}
		guard.nat.lookup(key)
		// fall through with existing mapping
		mapping, exists := guard.nat.lookup(key)
		if !exists {
			return nil
		}
		return rewriteV4(packet, ihl, net.IPv4(127, 0, 0, 1), mapping.relayPort, srcPort)
	}
	if flags&0x10 != 0 { // SYN+ACK from client is not a new connection
		return nil
	}
	key := makeKey(packet[12:16], packet[16:20], srcPort, binary.BigEndian.Uint16(tcp[2:4]))
	if _, exists := guard.nat.lookup(key); !exists {
		guard.nat.add(key, natMapping{
			relayPort:  guard.relay.port(),
			clientIP:   net.IP(append([]byte(nil), packet[12:16]...)),
			clientPort: srcPort,
			destIP:     net.IP(append([]byte(nil), packet[16:20]...)),
			destPort:   binary.BigEndian.Uint16(tcp[2:4]),
		})
	}
	mapping, _ := guard.nat.lookup(key)
	return rewriteV4(packet, ihl, net.IPv4(127, 0, 0, 1), mapping.relayPort, srcPort)
}

func (guard *WinDivertGuard) drainInbound(handle uintptr) {
	packet := make([]byte, 65535)
	address := make([]byte, 80)
	for {
		var received uint32
		ok, _, _ := winDivertRecvProc.Call(handle, uintptr(unsafe.Pointer(&packet[0])), uintptr(len(packet)), uintptr(unsafe.Pointer(&received)), uintptr(unsafe.Pointer(&address[0])))
		if ok == 0 {
			return
		}
		payload := packet[:received]
		if rewritten, good := guard.rewriteInbound(payload); good {
			var sent uint32
			_, _, _ = winDivertSendProc.Call(handle, uintptr(unsafe.Pointer(&rewritten[0])), uintptr(len(rewritten)), uintptr(unsafe.Pointer(&sent)), uintptr(unsafe.Pointer(&address[0])))
			continue
		}
		var sent uint32
		_, _, _ = winDivertSendProc.Call(handle, uintptr(unsafe.Pointer(&payload[0])), uintptr(len(payload)), uintptr(unsafe.Pointer(&sent)), uintptr(unsafe.Pointer(&address[0])))
	}
}

func (guard *WinDivertGuard) rewriteInbound(packet []byte) ([]byte, bool) {
	if guard == nil || guard.nat == nil || len(packet) < 40 || packet[0]>>4 != 4 {
		return nil, false
	}
	ihl := int(packet[0]&0x0f) * 4
	tcp := packet[ihl:]
	if len(tcp) < 20 || packet[9] != 6 {
		return nil, false
	}
	clientPort := binary.BigEndian.Uint16(tcp[2:4])
	mapping, ok := guard.nat.lookupClient(clientPort)
	if !ok {
		return nil, false
	}
	rewritten := append([]byte(nil), packet...)
	copy(rewritten[12:16], mapping.destIP.To4())
	copy(rewritten[16:20], mapping.clientIP.To4())
	binary.BigEndian.PutUint16(rewritten[ihl:], mapping.destPort)
	binary.BigEndian.PutUint16(rewritten[ihl+2:], mapping.clientPort)
	rewritten[10], rewritten[11] = 0, 0
	rewritten[ihl+16], rewritten[ihl+17] = 0, 0
	binary.BigEndian.PutUint16(rewritten[10:12], ipv4Checksum(rewritten[:ihl]))
	binary.BigEndian.PutUint16(rewritten[ihl+16:ihl+18], tcpChecksumV4(rewritten[12:16], rewritten[16:20], rewritten[ihl:]))
	return rewritten, true
}

func makeKey(src, dst []byte, srcPort, dstPort uint16) natKey {
	var key natKey
	copy(key.srcIP[:4], src)
	copy(key.dstIP[:4], dst)
	key.srcPort = srcPort
	key.dstPort = dstPort
	return key
}

func rewriteV4(packet []byte, ihl int, dstIP net.IP, dstPort, srcPort uint16) []byte {
	rewritten := append([]byte(nil), packet...)
	copy(rewritten[12:16], net.IPv4(127, 0, 0, 1).To4())
	copy(rewritten[16:20], dstIP.To4())
	binary.BigEndian.PutUint16(rewritten[ihl:], srcPort)
	binary.BigEndian.PutUint16(rewritten[ihl+2:], dstPort)
	rewritten[10], rewritten[11] = 0, 0
	rewritten[ihl+16], rewritten[ihl+17] = 0, 0
	binary.BigEndian.PutUint16(rewritten[10:12], ipv4Checksum(rewritten[:ihl]))
	binary.BigEndian.PutUint16(rewritten[ihl+16:ihl+18], tcpChecksumV4(rewritten[12:16], rewritten[16:20], rewritten[ihl:]))
	return rewritten
}

var _ = strconv.Itoa
var _ = context.Background
