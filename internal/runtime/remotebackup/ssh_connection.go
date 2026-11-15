package remotebackup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"
)

const defaultOperationTimeout = 2 * time.Minute

var errSSHConnectionClosed = errors.New("backup_ssh_connection_closed")

type sshBackupConnection struct {
	transport     net.Conn
	client        *ssh.Client
	sftp          *sftpClient
	baseDir       string
	fingerprint   string
	keepaliveStop chan struct{}
	closed        atomic.Bool
}

func (c *sshBackupConnection) close() error {
	if c == nil || c.closed.Swap(true) {
		return nil
	}
	if c.keepaliveStop != nil {
		close(c.keepaliveStop)
	}
	// Closing net.Conn wakes blocked SSH reads/writes without acquiring the
	// SFTP RPC lock. All outstanding operations fail on this exact generation.
	var errs []error
	if c.transport != nil {
		errs = append(errs, c.transport.Close())
	}
	if c.client != nil {
		errs = append(errs, c.client.Close())
	}
	if c.sftp != nil {
		errs = append(errs, c.sftp.Close())
	}
	var unexpected []error
	for _, err := range errs {
		if err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, io.EOF) {
			unexpected = append(unexpected, err)
		}
	}
	return errors.Join(unexpected...)
}

type sshConnectFlight struct {
	done       chan struct{}
	cancel     context.CancelFunc
	connection *sshBackupConnection
	err        error
}

func (s *SSHBackupStrategy) connectionFor(ctx context.Context) (*sshBackupConnection, error) {
	if ctx == nil {
		return nil, errors.New("backup_context_required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.connection != nil && !s.connection.closed.Load() {
		conn := s.connection
		s.mu.Unlock()
		return conn, nil
	}
	if flight := s.connecting; flight != nil {
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-flight.done:
			if flight.err != nil {
				return nil, flight.err
			}
			if flight.connection == nil || flight.connection.closed.Load() {
				return nil, errSSHConnectionClosed
			}
			return flight.connection, nil
		}
	}
	timeout := s.deps.ReadyTimeout
	if timeout <= 0 {
		timeout = defaultReadyTimeout
	}
	connectCtx, cancel := context.WithTimeout(ctx, timeout)
	flight := &sshConnectFlight{done: make(chan struct{}), cancel: cancel}
	s.connecting = flight
	s.mu.Unlock()
	conn, err := s.openConnection(connectCtx)
	s.mu.Lock()
	if ctxErr := connectCtx.Err(); ctxErr != nil {
		err = ctxErr
	}
	if s.connecting != flight {
		err = errSSHConnectionClosed
	}
	if err == nil {
		s.connection = conn
		s.baseDir = conn.baseDir
		s.observedFingerprint = conn.fingerprint
	}
	flight.connection, flight.err = conn, err
	if s.connecting == flight {
		s.connecting = nil
	}
	close(flight.done)
	s.mu.Unlock()
	cancel()
	if err != nil {
		_ = conn.close()
		return nil, err
	}
	if s.target.HostKeyFingerprint == "" && conn.fingerprint != "" && s.deps.OnHostKey != nil {
		s.deps.OnHostKey(conn.fingerprint)
	}
	return conn, nil
}

func (s *SSHBackupStrategy) openConnection(ctx context.Context) (*sshBackupConnection, error) {
	config, observed, err := s.buildSSHClientConfig()
	if err != nil {
		return nil, err
	}
	port := s.target.Port
	if port <= 0 {
		port = 22
	}
	transport, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(s.target.Host, fmt.Sprint(port)))
	if err != nil {
		return nil, err
	}
	conn := &sshBackupConnection{transport: transport}
	stop := context.AfterFunc(ctx, func() { _ = transport.Close() })
	defer stop()
	fail := func(e error) (*sshBackupConnection, error) {
		_ = conn.close()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, e
	}
	// Cover SSH handshake, subsystem negotiation, realpath and initial mkdirs.
	if deadline, ok := ctx.Deadline(); ok {
		_ = transport.SetDeadline(deadline)
	}
	sshConn, chans, reqs, err := ssh.NewClientConn(transport, net.JoinHostPort(s.target.Host, fmt.Sprint(port)), config)
	if err != nil {
		return fail(err)
	}
	conn.client = ssh.NewClient(sshConn, chans, reqs)
	conn.sftp, err = newSFTPClient(conn.client)
	if err != nil {
		return fail(err)
	}
	home, err := conn.sftp.Realpath(".")
	if err != nil {
		return fail(err)
	}
	conn.baseDir, err = ResolveRemoteDir(s.target.RemoteDir, home)
	if err != nil {
		return fail(err)
	}
	if err = ensureRemoteDir(conn.sftp, conn.baseDir); err != nil {
		return fail(err)
	}
	if !stop() || ctx.Err() != nil {
		return fail(ctx.Err())
	}
	if err = transport.SetDeadline(time.Time{}); err != nil {
		return fail(err)
	}
	conn.fingerprint = *observed
	conn.keepaliveStop = make(chan struct{})
	interval := s.deps.KeepaliveInterval
	if interval <= 0 {
		interval = defaultKeepaliveInterval
	}
	go conn.keepalive(interval)
	return conn, nil
}

func (s *SSHBackupStrategy) withConnection(ctx context.Context, operation func(*sshBackupConnection) error) error {
	if ctx == nil {
		return errors.New("backup_context_required")
	}
	timeout := s.deps.OperationTimeout
	if timeout <= 0 {
		timeout = defaultOperationTimeout
	}
	opCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, err := s.connectionFor(opCtx)
	if err != nil {
		return err
	}
	if err = opCtx.Err(); err != nil {
		return err
	}
	done := make(chan struct{})
	stop := context.AfterFunc(opCtx, func() { s.invalidate(conn); close(done) })
	err = operation(conn)
	if !stop() {
		<-done
	}
	if opCtx.Err() != nil {
		return errors.Join(opCtx.Err(), err)
	}
	if err != nil {
		// Status errors are complete responses. A framing/transport failure makes
		// request ordering unknown and must not be reused for a subsequent operation.
		if !completeSFTPStatus(err) {
			s.invalidate(conn)
		}
	}
	return err
}

func (s *SSHBackupStrategy) invalidate(conn *sshBackupConnection) {
	s.mu.Lock()
	if s.connection == conn {
		s.connection = nil
	}
	s.mu.Unlock()
	_ = conn.close()
}

func (c *sshBackupConnection) keepalive(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-c.keepaliveStop:
			return
		case <-ticker.C:
			timer := time.AfterFunc(interval, func() { _ = c.close() })
			_, _, err := c.client.SendRequest("keepalive@openssh.com", true, nil)
			timer.Stop()
			if err != nil {
				_ = c.close()
				return
			}
		}
	}
}
