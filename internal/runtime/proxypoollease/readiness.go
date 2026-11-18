package proxypoollease

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/egress"
)

const healthTimeout = 500 * time.Millisecond

func waitReady(ctx context.Context, runtime *Runtime, ports *reservedPorts, secret, token string, output *coreOutput) error {
	transport := &http.Transport{
		Proxy:                  nil, // Never use an environment-configured HTTP proxy.
		DisableKeepAlives:      true,
		MaxResponseHeaderBytes: 8 * 1024,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		Transport: transport,
		Timeout:   healthTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	ticker := time.NewTicker(egress.DefaultStartupPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-output.collision:
			return errPortCollision
		case <-runtime.exited:
			select {
			case <-output.collision:
				return errPortCollision
			default:
				return errors.New("proxy_pool_lease_core_exited")
			}
		default:
		}
		ready, err := controllerReady(ctx, client, ports.controlAddress(), secret)
		if err != nil {
			return err
		}
		if ready {
			ready, err = proxyReady(ctx, ports.proxyAddress(), token)
			if err != nil {
				return err
			}
		}
		if ready {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-output.collision:
				return errPortCollision
			case <-runtime.exited:
				return errors.New("proxy_pool_lease_core_exited")
			default:
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-output.collision:
			return errPortCollision
		case <-runtime.exited:
			// Re-enter the top check so drained output can classify bind failure.
		case <-ticker.C:
		}
	}
}

func controllerReady(ctx context.Context, client *http.Client, address, secret string) (bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+address+"/version", nil)
	if err != nil {
		return false, errors.New("proxy_pool_lease_health_request_failed")
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	response, err := client.Do(request)
	if err != nil {
		return false, nil
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 8*1024))
	_ = response.Body.Close()
	if readErr != nil {
		return false, nil
	}
	var version struct {
		Version string `json:"version"`
	}
	if response.StatusCode != http.StatusOK || json.Unmarshal(data, &version) != nil || version.Version == "" {
		return false, errPortCollision
	}
	// An open service ignoring Authorization is not proof that this is our
	// controller. A second request must reject missing credentials.
	request.Header.Del("Authorization")
	response, err = client.Do(request)
	if err != nil {
		return false, nil
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized && response.StatusCode != http.StatusForbidden {
		return false, errPortCollision
	}
	return true, nil
}

func proxyReady(ctx context.Context, address, token string) (bool, error) {
	probeCtx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(probeCtx, "tcp4", address)
	if err != nil {
		return false, nil
	}
	defer conn.Close()
	stop := context.AfterFunc(probeCtx, func() { _ = conn.Close() })
	defer stop()
	deadline, _ := probeCtx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return false, nil
	}
	// The mixed listener speaks SOCKS5 as well as HTTP. Authenticate without a
	// CONNECT request, proving listener ownership without probing the internet.
	// Offer both methods: anonymous cores must pick no-auth, not accept an
	// arbitrary password merely because password auth was the only option.
	if _, err := conn.Write([]byte{5, 2, 0, 2}); err != nil {
		return false, nil
	}
	var reply [2]byte
	if _, err := io.ReadFull(conn, reply[:]); err != nil {
		return false, nil
	}
	if reply != [2]byte{5, 2} {
		return false, errPortCollision
	}
	auth := append([]byte{1, 3, 'a', 'i', 'h', byte(len(token))}, token...)
	if _, err := conn.Write(auth); err != nil {
		return false, nil
	}
	if _, err := io.ReadFull(conn, reply[:]); err != nil {
		return false, nil
	}
	if reply != [2]byte{1, 0} {
		return false, errPortCollision
	}
	return true, nil
}
