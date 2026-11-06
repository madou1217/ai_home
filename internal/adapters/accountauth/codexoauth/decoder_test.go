package codexoauth

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/accountauth"
)

// TestDecodeIDTokenAccount 覆盖 ID Token 公开字段的取值链与缺失语义。
func TestDecodeIDTokenAccount(t *testing.T) {
	testCases := []struct {
		name  string
		token string
		want  accountauth.Account
	}{
		{
			name: "profile_email_takes_precedence",
			token: fakeJWT(`{"sub":"user","email":"top@example.com","name":"Top Name",` +
				`"https://api.openai.com/profile":{"email":"profile@example.com"},` +
				`"https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}`),
			want: accountauth.Account{
				Email:       "profile@example.com",
				DisplayName: "Top Name",
				PlanType:    "plus",
			},
		},
		{
			name: "top_level_email_and_split_name",
			token: fakeJWT(`{"sub":"user","email":"ada@example.com","given_name":"Ada","family_name":"Lovelace",` +
				`"https://api.openai.com/auth":{"chatgpt_plan_type":"pro"}}`),
			want: accountauth.Account{
				Email:       "ada@example.com",
				DisplayName: "Ada Lovelace",
				PlanType:    "pro",
			},
		},
		{
			name: "display_name_falls_back_to_email",
			token: fakeJWT(`{"sub":"user","email":"only@example.com",` +
				`"https://api.openai.com/auth":{"chatgpt_plan_type":"business"}}`),
			want: accountauth.Account{
				Email:       "only@example.com",
				DisplayName: "only@example.com",
				PlanType:    "business",
			},
		},
		{
			name:  "missing_optional_claims_stay_empty",
			token: fakeJWT(`{"sub":"user","https://api.openai.com/auth":{"chatgpt_user_id":"user"}}`),
			want:  accountauth.Account{},
		},
		{
			name:  "null_and_unknown_claims_stay_empty",
			token: fakeJWT(`{"sub":"user","email":null,"name":null,"https://api.openai.com/auth":{"chatgpt_plan_type":null,"future":"value"}}`),
			want:  accountauth.Account{},
		},
		{
			name:  "wrong_claim_type_does_not_leak_partial_result",
			token: fakeJWT(`{"email":"good@example.com","https://api.openai.com/auth":"not-an-object"}`),
			want:  accountauth.Account{},
		},
		{
			name:  "replacement_character_is_rejected",
			token: fakeJWT(`{"name":"bad\ud800name","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}`),
			want:  accountauth.Account{PlanType: "plus"},
		},
		{
			name:  "control_characters_are_rejected",
			token: fakeJWT(`{"email":"bad\u0001@example.com","name":"a\nb","https://api.openai.com/auth":{"chatgpt_plan_type":"p\u0000"}}`),
			want:  accountauth.Account{},
		},
		{
			name: "overlong_values_are_rejected",
			token: fakeJWT(fmt.Sprintf(
				`{"email":%q,"name":%q,"https://api.openai.com/auth":{"chatgpt_plan_type":%q}}`,
				strings.Repeat("a", maxAccountEmailLength)+"@example.com",
				strings.Repeat("n", maxAccountNameLength+1),
				strings.Repeat("p", maxAccountPlanLength+1),
			)),
			want: accountauth.Account{},
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := decodeIDTokenAccount(testCase.token); got != testCase.want {
				t.Fatalf("decodeIDTokenAccount() = %#v, want %#v", got, testCase.want)
			}
		})
	}
}

// TestDecodeIDTokenAccountRejectsMalformedTokens 保证畸形输入不 panic、不误报。
func TestDecodeIDTokenAccountRejectsMalformedTokens(t *testing.T) {
	invalidUTF8 := base64.RawURLEncoding.EncodeToString([]byte{0xff, 0xfe})
	paddedPayload := base64.URLEncoding.EncodeToString([]byte(
		`{"email":"padded@example.com","https://api.openai.com/auth":{"chatgpt_plan_type":"plus"}}`,
	))
	testCases := []struct {
		name  string
		token string
	}{
		{name: "empty", token: ""},
		{name: "whitespace", token: "   "},
		{name: "not_a_jwt", token: "not-a-jwt"},
		{name: "two_segments", token: "a.b"},
		{name: "four_segments", token: "a.b.c.d"},
		{name: "empty_payload", token: "a..c"},
		{name: "invalid_base64", token: "a.@@@.c"},
		{name: "non_json_payload", token: fakeJWT(`not json`)},
		{name: "json_array_payload", token: fakeJWT(`[]`)},
		{name: "numeric_email", token: fakeJWT(`{"email":123}`)},
		{name: "invalid_utf8_payload", token: "a." + invalidUTF8 + ".c"},
		{name: "oversized_token", token: strings.Repeat("a", maxIDTokenBytes+1)},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := decodeIDTokenAccount(testCase.token); got != (accountauth.Account{}) {
				t.Fatalf("decodeIDTokenAccount(%q) = %#v, want 零值", testCase.name, got)
			}
		})
	}

	// 非标准但可容忍的 padding 仍应解析成功，避免把合法实现误判成畸形。
	t.Run("padded_base64_payload", func(t *testing.T) {
		got := decodeIDTokenAccount("a." + paddedPayload + ".c")
		if got.Email != "padded@example.com" || got.PlanType != "plus" {
			t.Fatalf("padded payload = %#v", got)
		}
	})
}
