package sshproxy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
)

const managedSourceID = "aih-managed-ssh"

// publish updates only our managed source, using the canonical pool store lock.
// Identity is the SSH connection ID, not the ephemeral local listener port.
func (s *Supervisor) publish() error {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	s.mu.Lock()
	nodes := []subaggregator.ProxyNode{}
	registry := map[string]any{}
	now := time.Now().UnixMilli()
	for id, entry := range s.entries {
		port := entry.port
		state := "connecting"
		if entry.ready {
			state = "ready"
		} else if entry.err != "" {
			state = "error"
		}
		nodeID := "ssh:" + id
		identity := "ssh|" + id
		node := subaggregator.ProxyNode{"id": nodeID, "name": entry.spec.Name, "protocol": "http", "server": "127.0.0.1", "port": port, "username": "aih", "password": entry.token, "source": "ssh", "managedBy": "sshproxy", "sshConnectionId": id, "subscriptionId": managedSourceID, "available": entry.ready, "lifecycle": state, "exitIdentity": identity, "ownerPid": os.Getpid(), "updatedAt": now}
		if entry.err != "" {
			node["error"] = entry.err
		}
		nodes = append(nodes, node)
		if entry.ready {
			registry[id] = map[string]any{"port": port, "tokenHash": digest(entry.token), "ownerPid": os.Getpid(), "nodeId": nodeID, "exitIdentity": identity}
		}
	}
	s.mu.Unlock()
	// Runtime registry is provenance evidence, not another mutable node catalog.
	if err := writeRegistry(filepath.Join(s.aiHome, "run", "ssh-proxy-endpoints.json"), registry); err != nil {
		return err
	}
	store := subaggregator.NewStore(s.aiHome)
	_, err := store.MutateProxyPool(func(data *subaggregator.ProxyPoolStoreData) error {
		retained := make([]subaggregator.ProxyNode, 0, len(data.Nodes)+len(nodes))
		for _, node := range data.Nodes {
			if node.Str("managedBy") != "sshproxy" {
				retained = append(retained, node)
			}
		}
		data.Nodes = append(retained, nodes...)
		subs := make([]subaggregator.Subscription, 0, len(data.Subscriptions)+1)
		for _, sub := range data.Subscriptions {
			if sub.ID != managedSourceID {
				subs = append(subs, sub)
			}
		}
		if len(nodes) > 0 {
			subs = append(subs, subaggregator.Subscription{ID: managedSourceID, Name: "SSH 受管出口", Kind: "managed", Enabled: true, NodeCount: len(nodes), LastSyncedAt: &now})
		}
		data.Subscriptions = subs
		return nil
	})
	return err
}
func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func writeRegistry(path string, entries map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".ssh-proxy-registry-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	data, err := jsonRegistry(entries)
	if err == nil {
		_, err = f.Write(data)
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), path)
}
func jsonRegistry(entries map[string]any) ([]byte, error) {
	return json.Marshal(map[string]any{"ownerPid": os.Getpid(), "endpoints": entries})
}
func (s *Supervisor) ProxyURL(id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.entries[id]
	if entry == nil || !entry.ready {
		return "", fmt.Errorf("SSH proxy unavailable")
	}
	return fmt.Sprintf("http://aih:%s@127.0.0.1:%d", entry.token, entry.port), nil
}
