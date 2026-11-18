// Package sshproxy owns authenticated, loopback-only SSH network outlets.
package sshproxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/managedproxy"
)

type Candidate struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Source    string `json:"source"`
	Available bool   `json:"available"`
	Error     string `json:"error,omitempty"`
}
type outlet struct {
	spec     spec
	cancel   context.CancelFunc
	client   *sshremote.Client
	listener net.Listener
	server   *http.Server
	token    string
	port     int
	ready    bool
	err      string
	sockets  map[net.Conn]bool
}
type Supervisor struct {
	home, aiHome string
	known        map[string]string
	mu           sync.Mutex
	entries      map[string]*outlet
	closed       bool
	publishMu    sync.Mutex
	closeHooks   []func()
}

func New(aiHome, home string, known map[string]string) *Supervisor {
	return &Supervisor{home: home, aiHome: aiHome, known: known, entries: map[string]*outlet{}}
}

func (s *Supervisor) Reconcile(raw []byte) error {
	items, err := specs(raw, s.home, s.known)
	if err != nil {
		return err
	}
	wanted := map[string]spec{}
	for _, item := range items {
		wanted[item.ID] = item
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return fmt.Errorf("SSH proxy supervisor closed")
	}
	var closing []*outlet
	for id, current := range s.entries {
		next, ok := wanted[id]
		if !ok || !sameSpec(current.spec, next) {
			closing = append(closing, current)
			delete(s.entries, id)
		}
	}
	for id, item := range wanted {
		if _, ok := s.entries[id]; ok {
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		entry := &outlet{spec: item, cancel: cancel, err: item.Error, sockets: map[net.Conn]bool{}}
		s.entries[id] = entry
		if item.Error == "" {
			go s.run(ctx, entry)
		}
	}
	s.mu.Unlock()
	for _, entry := range closing {
		s.closeOutlet(entry)
	}
	return s.publish()
}
func sameSpec(a, b spec) bool {
	aRaw, _ := json.Marshal(struct {
		ID, Name, Error string
		Config          any
	}{a.ID, a.Name, a.Error, configIdentity(a.Config)})
	bRaw, _ := json.Marshal(struct {
		ID, Name, Error string
		Config          any
	}{b.ID, b.Name, b.Error, configIdentity(b.Config)})
	return string(aRaw) == string(bRaw)
}
func configIdentity(c sshremote.Config) any {
	var jump any
	if c.Jump != nil {
		jump = configIdentity(*c.Jump)
	}
	return []any{c.Host, c.Port, c.User, c.AuthType, c.Password, c.PrivateKey, c.IdentityFile, jump}
}

func (s *Supervisor) run(ctx context.Context, entry *outlet) {
	attempt := 0
	for ctx.Err() == nil {
		client, err := sshremote.Dial(ctx, entry.spec.Config, 15*time.Second)
		if err == nil {
			err = probeOutlet(ctx, client)
			if err == nil {
				err = s.serve(ctx, entry, client)
			} else {
				_ = client.Close()
			}
		}
		s.mu.Lock()
		if s.entries[entry.spec.ID] == entry {
			entry.ready = false
			entry.client = nil
			if ctx.Err() == nil {
				entry.err = safeError(err)
			}
		}
		s.mu.Unlock()
		_ = s.publish()
		attempt++
		delay := time.Duration(attempt*2) * time.Second
		if delay > 30*time.Second {
			delay = 30 * time.Second
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(delay):
		}
	}
}
func safeError(err error) string {
	if err == nil {
		return "SSH connection closed"
	}
	if typed, ok := err.(*sshremote.Error); ok {
		return typed.Error()
	}
	return "SSH outlet unavailable"
}
func (s *Supervisor) serve(ctx context.Context, entry *outlet, client *sshremote.Client) error {
	defer client.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	secret := make([]byte, 24)
	if _, err = rand.Read(secret); err != nil {
		return err
	}
	token := hex.EncodeToString(secret)
	resolver := managedproxy.NewResolver(client.DialTCP)
	server := &http.Server{Handler: managedproxy.Handler{Dial: client.DialTCP, Resolve: resolver.Resolve, Token: token, OnTunnelClosed: func(c net.Conn) { s.mu.Lock(); delete(entry.sockets, c); s.mu.Unlock() }}, ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 16 * 1024, ConnState: func(connection net.Conn, state http.ConnState) {
		s.mu.Lock()
		defer s.mu.Unlock()
		if state == http.StateClosed {
			delete(entry.sockets, connection)
		} else {
			entry.sockets[connection] = true
		}
	}}
	s.mu.Lock()
	if s.entries[entry.spec.ID] != entry || s.closed {
		s.mu.Unlock()
		return fmt.Errorf("outlet replaced")
	}
	entry.client = client
	entry.listener = listener
	entry.server = server
	entry.token = token
	entry.port = listener.Addr().(*net.TCPAddr).Port
	entry.ready = true
	entry.err = ""
	s.mu.Unlock()
	_ = s.publish()
	done := make(chan error, 1)
	go func() { done <- client.Wait() }()
	go server.Serve(listener)
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	defer server.Close()
	defer func() {
		s.mu.Lock()
		for socket := range entry.sockets {
			_ = socket.Close()
		}
		s.mu.Unlock()
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case err := <-done:
			return err
		case <-ticker.C:
			probe, cancel := context.WithTimeout(ctx, 10*time.Second)
			err := client.KeepAlive(probe)
			cancel()
			if err != nil {
				return err
			}
		}
	}
}
func (s *Supervisor) Candidates() []Candidate {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]Candidate, 0, len(s.entries))
	for id, entry := range s.entries {
		result = append(result, Candidate{ID: "ssh:" + id, Name: entry.spec.Name, Source: "ssh", Available: entry.ready, Error: entry.err})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}
func (s *Supervisor) Dial(ctx context.Context, id, address string) (net.Conn, error) {
	s.mu.Lock()
	entry := s.entries[id]
	var client *sshremote.Client
	if entry != nil && entry.ready {
		client = entry.client
	}
	s.mu.Unlock()
	if client == nil {
		return nil, fmt.Errorf("SSH proxy not ready")
	}
	return client.DialTCP(ctx, "tcp", address)
}
func (s *Supervisor) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	entries := make([]*outlet, 0, len(s.entries))
	for _, entry := range s.entries {
		entries = append(entries, entry)
	}
	s.entries = map[string]*outlet{}
	hooks := append([]func(){}, s.closeHooks...)
	s.mu.Unlock()
	for _, entry := range entries {
		s.closeOutlet(entry)
	}
	for _, hook := range hooks {
		hook()
	}
	_ = s.publish()
}

func (s *Supervisor) closeOutlet(entry *outlet) {
	s.mu.Lock()
	entry.cancel()
	server, client := entry.server, entry.client
	sockets := make([]net.Conn, 0, len(entry.sockets))
	for c := range entry.sockets {
		sockets = append(sockets, c)
	}
	s.mu.Unlock()
	if server != nil {
		_ = server.Close()
	}
	if client != nil {
		_ = client.Close()
	}
	for _, c := range sockets {
		_ = c.Close()
	}
}

func (s *Supervisor) onClose(hook func()) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		hook()
		return
	}
	s.closeHooks = append(s.closeHooks, hook)
	s.mu.Unlock()
}
