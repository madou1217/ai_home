package sshhostbrowse

import (
	"context"
	"errors"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/sshhost"
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
	if !errors.As(err, &failure) || failure.Code != "ssh_egress_unresolved" {
		t.Fatalf("err = %v", err)
	}
}

func TestConfigForResolvesJumpChain(t *testing.T) {
	config := configFor(webuisshhostbrowseapi.Conn{
		Host: "target", Port: 2200, User: "target-user", AuthType: "agent",
		EgressConnectionID: "jump-1",
		Jump: &webuisshhostbrowseapi.Conn{
			Host: "jump", Port: 22, User: "jump-user", AuthType: "password", Password: "secret",
		},
	}, "/home/me")
	if config.Jump == nil || config.Jump.Host != "jump" || config.Jump.User != "jump-user" {
		t.Fatalf("jump = %+v", config.Jump)
	}
	if config.Host != "target" || config.Port != 2200 {
		t.Fatalf("target = %+v", config)
	}
}

func TestTranslateKeepsSSHRemoteCode(t *testing.T) {
	failure := translate(&sshremote.Error{Code: "ssh_auth_failed", Message: "认证失败"})
	var remote *webuisshhostbrowseapi.RemoteFailure
	if !errors.As(failure, &remote) || remote.Code != "ssh_auth_failed" || remote.Message != "认证失败" {
		t.Fatalf("failure = %#v", failure)
	}
}


func TestParseDetectAndHome(t *testing.T) {
	dialect, home, ok := parseDetectAndHome("Linux\nAIH_POSIX\n/home/deploy\n")
	if !ok || dialect != "posix" || home != "/home/deploy" {
		t.Fatalf("posix = (%q, %q, %v)", dialect, home, ok)
	}
	dialect, home, ok = parseDetectAndHome("AIH_WINDOWS\r\nC:\\Users\\dev\r\n")
	if !ok || dialect != "powershell" || home != `C:\Users\dev` {
		t.Fatalf("win = (%q, %q, %v)", dialect, home, ok)
	}
}

func TestTranslateIdentityFileErrorPreservesReason(t *testing.T) {
	err := translate(&sshremote.Error{
		Code:    sshremote.CodeKeyInvalid,
		Message: "bad key",
		Err:     &sshhost.IdentityFileError{Code: sshhost.IdentityFileOutsideSSHDir},
	})
	var remote *webuisshhostbrowseapi.RemoteFailure
	if !errors.As(err, &remote) || remote.Code != "invalid_identity_file" || remote.Reason != sshhost.IdentityFileOutsideSSHDir {
		t.Fatalf("remote = %#v", remote)
	}
}
