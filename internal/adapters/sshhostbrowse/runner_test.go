package sshhostbrowse

import (
	"context"
	"errors"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshhostbrowseapi"
)

func TestConfigForMapsConnectionFields(t *testing.T) {
	config := configFor(webuisshhostbrowseapi.Conn{
		Host: "example.com", Port: 2222, User: "me",
		AuthType: "key-file", IdentityFile: "~/.ssh/id_ed25519",
	}, "/home/me")
	if config.Host != "example.com" || config.Port != 2222 || config.User != "me" {
		t.Fatalf("config = %+v", config)
	}
	if config.AuthType != sshremote.AuthKeyFile || config.IdentityFile != "~/.ssh/id_ed25519" {
		t.Fatalf("auth = %+v", config)
	}
	if config.HomeDir != "/home/me" {
		t.Fatalf("home = %q", config.HomeDir)
	}
}

func TestRunRejectsTunnelConnectionsBeforeDial(t *testing.T) {
	runner := Runner{}
	_, err := runner.Run(context.Background(), webuisshhostbrowseapi.Conn{
		Host: "example.com", EgressConnectionID: "egress-1",
	}, []string{"sh", "-c", "ls"})
	var failure *webuisshhostbrowseapi.RemoteFailure
	if !errors.As(err, &failure) || failure.Code != "ssh_tunnel_unsupported" {
		t.Fatalf("err = %v", err)
	}
}

func TestTranslateKeepsSSHRemoteCode(t *testing.T) {
	failure := translate(&sshremote.Error{Code: "ssh_auth_failed", Message: "认证失败"})
	var remote *webuisshhostbrowseapi.RemoteFailure
	if !errors.As(failure, &remote) || remote.Code != "ssh_auth_failed" || remote.Message != "认证失败" {
		t.Fatalf("failure = %#v", failure)
	}
}
