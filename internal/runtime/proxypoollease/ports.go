package proxypoollease

import (
	"errors"
	"net"
	"strconv"
	"syscall"

	"github.com/madou1217/ai_home/internal/runtime/egress"
)

type reservedPorts struct {
	proxyPort   int
	controlPort int
	proxy       net.Listener
	control     net.Listener
	udp         net.PacketConn
}

func reservePorts() (*reservedPorts, error) {
	ports := &reservedPorts{}
	var err error
	ports.proxy, err = net.Listen("tcp4", net.JoinHostPort(egress.PoolBindHost, "0"))
	if err == nil {
		ports.proxyPort = ports.proxy.Addr().(*net.TCPAddr).Port
		ports.udp, err = net.ListenPacket("udp4", ports.proxyAddress())
	}
	if err == nil {
		ports.control, err = net.Listen("tcp4", net.JoinHostPort(egress.PoolControllerHost, "0"))
	}
	if err != nil {
		ports.close()
		if errors.Is(err, syscall.EADDRINUSE) {
			return nil, errPortCollision
		}
		return nil, errors.New("proxy_pool_lease_port_allocation_failed")
	}
	ports.controlPort = ports.control.Addr().(*net.TCPAddr).Port
	return ports, nil
}

func (p *reservedPorts) proxyAddress() string {
	return net.JoinHostPort(egress.PoolBindHost, strconv.Itoa(p.proxyPort))
}

func (p *reservedPorts) controlAddress() string {
	return net.JoinHostPort(egress.PoolControllerHost, strconv.Itoa(p.controlPort))
}

func (p *reservedPorts) close() {
	if p.proxy != nil {
		_ = p.proxy.Close()
	}
	if p.control != nil {
		_ = p.control.Close()
	}
	if p.udp != nil {
		_ = p.udp.Close()
	}
}
