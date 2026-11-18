package managedproxy

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"time"
)

// SOCKSDial adapts existing SOCKS5 pool nodes to task-local HTTP ingress.
func SOCKSDial(ctx context.Context, proxy *url.URL, address string) (net.Conn, error) {
	host := proxy.Host
	if proxy.Port() == "" {
		host = net.JoinHostPort(proxy.Hostname(), "1080")
	}
	connection, err := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", host)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			connection.Close()
		}
	}()
	_ = connection.SetDeadline(time.Now().Add(20 * time.Second))
	methods := []byte{5, 1, 0}
	if proxy.User != nil {
		methods = []byte{5, 2, 0, 2}
	}
	if _, err = connection.Write(methods); err != nil {
		return nil, err
	}
	response := make([]byte, 2)
	if _, err = io.ReadFull(connection, response); err != nil {
		return nil, err
	}
	if response[0] != 5 {
		return nil, fmt.Errorf("invalid SOCKS response")
	}
	if response[1] == 2 {
		if proxy.User == nil {
			return nil, fmt.Errorf("SOCKS authentication required")
		}
		password, _ := proxy.User.Password()
		user := proxy.User.Username()
		if len(user) > 255 || len(password) > 255 {
			return nil, fmt.Errorf("invalid SOCKS credentials")
		}
		auth := append([]byte{1, byte(len(user))}, []byte(user)...)
		auth = append(auth, byte(len(password)))
		auth = append(auth, []byte(password)...)
		if _, err = connection.Write(auth); err != nil {
			return nil, err
		}
		if _, err = io.ReadFull(connection, response); err != nil || response[1] != 0 {
			return nil, fmt.Errorf("SOCKS authentication failed")
		}
	} else if response[1] != 0 {
		return nil, fmt.Errorf("SOCKS authentication unavailable")
	}
	name, port, err := net.SplitHostPort(address)
	if err != nil || len(name) > 255 {
		return nil, fmt.Errorf("invalid SOCKS destination")
	}
	number, err := strconv.Atoi(port)
	if err != nil {
		return nil, err
	}
	request := append([]byte{5, 1, 0, 3, byte(len(name))}, []byte(name)...)
	request = binary.BigEndian.AppendUint16(request, uint16(number))
	if _, err = connection.Write(request); err != nil {
		return nil, err
	}
	head := make([]byte, 4)
	if _, err = io.ReadFull(connection, head); err != nil || head[1] != 0 {
		return nil, fmt.Errorf("SOCKS destination unavailable")
	}
	length := 0
	switch head[3] {
	case 1:
		length = 4
	case 4:
		length = 16
	case 3:
		if _, err = io.ReadFull(connection, response[:1]); err != nil {
			return nil, err
		}
		length = int(response[0])
	default:
		return nil, fmt.Errorf("invalid SOCKS address")
	}
	if _, err = io.CopyN(io.Discard, connection, int64(length+2)); err != nil {
		return nil, err
	}
	_ = connection.SetDeadline(time.Time{})
	ok = true
	return connection, nil
}
