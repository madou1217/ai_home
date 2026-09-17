package accounts

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
)

func nativeGenerationFixture(t *testing.T, payload string, values ...NativeGeneration) *NativeCredential {
	t.Helper()
	identity, err := NewNativeSubjectIdentity("kimi", "user-A")
	if err != nil {
		t.Fatal(err)
	}
	credential, err := NewNativeCredential(identity, []byte(payload), values...)
	if err != nil {
		t.Fatal(err)
	}
	return credential
}

func TestNativeGenerationUsesPartialOrderNotArrivalOrder(t *testing.T) {
	before := nativeGenerationFixture(t, `{"grant":"old"}`, NativeGeneration{"access.iat", 1000}, NativeGeneration{"other.iat", 1000})
	tests := []struct {
		name           string
		values         []NativeGeneration
		newer, ordered bool
	}{
		{"newer", []NativeGeneration{{"access.iat", 2000}, {"other.iat", 1000}}, true, true},
		{"older", []NativeGeneration{{"access.iat", 500}, {"other.iat", 1000}}, false, true},
		{"mixed", []NativeGeneration{{"access.iat", 2000}, {"other.iat", 500}}, false, false},
		{"different-source", []NativeGeneration{{"expires", 2000}, {"other.iat", 1000}}, false, false},
		{"equal-but-different-grant", []NativeGeneration{{"access.iat", 1000}, {"other.iat", 1000}}, false, false},
		{"no-evidence", nil, false, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			incoming := nativeGenerationFixture(t, `{"grant":"new"}`, tc.values...)
			newer, ordered := incoming.NewerThan(before)
			if newer != tc.newer || ordered != tc.ordered {
				t.Fatalf("got (%v,%v), want (%v,%v)", newer, ordered, tc.newer, tc.ordered)
			}
		})
	}
	if newer, ordered := before.NewerThan(before); newer || !ordered {
		t.Fatal("identical payload is not idempotent")
	}
}

func TestNativeCredentialCopiesAndRedactsInputs(t *testing.T) {
	identity, _ := NewNativeSubjectIdentity("kimi", "user-A")
	payload := []byte(`{"refresh_token":"not-a-real-secret"}`)
	generations := []NativeGeneration{{"access.iat", 1000}}
	credential, err := NewNativeCredential(identity, payload, generations...)
	if err != nil {
		t.Fatal(err)
	}
	payload[0] = 'x'
	generations[0].Value = 5
	copy := credential.Payload()
	copy[0] = 'y'
	if !bytes.HasPrefix(credential.Payload(), []byte("{")) || credential.Generations()[0].Value != 1000 {
		t.Fatal("input aliases escaped the value boundary")
	}
	if strings.Contains(fmt.Sprintf("%v %#v", credential, credential), "not-a-real-secret") {
		t.Fatal("credential formatter leaked")
	}
	grant := NativeOpenCodeGrant{Upstream: "x", Type: "api", Secret: "not-a-real-secret"}
	if strings.Contains(fmt.Sprintf("%v %#v", grant, grant), "not-a-real-secret") {
		t.Fatal("constructor input formatter leaked")
	}
}

func TestNativeIdentityRejectsControlAndUnsupportedAuthority(t *testing.T) {
	for _, subject := range []string{"bad\u0001id", "bad\u0085id", " spaced ", "a:b", ""} {
		if _, err := NewNativeSubjectIdentity("kimi", subject); err == nil {
			t.Fatalf("accepted %q", subject)
		}
	}
	if _, err := NewNativeKiroIdentity("https://codewhisperer.invalid-region.amazonaws.com", "user"); err == nil {
		t.Fatal("accepted unknown region shape")
	}
	if _, err := NewNativeOpenCodeIdentity([]NativeOpenCodeGrant{{"UPSTREAM", "api", "", "key"}, {"upstream", "oauth", "user", ""}}); err == nil {
		t.Fatal("normalized upstream collision accepted")
	}
}
