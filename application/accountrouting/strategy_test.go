package accountrouting

import (
	"context"
	"errors"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// TestParseSelectionStrategy 验证策略解析与 Node 同构的默认值。
func TestParseSelectionStrategy(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name    string
		value   string
		want    SelectionStrategy
		wantErr bool
	}{
		{name: "empty defaults to Node random", value: "", want: StrategyRandom},
		{name: "random", value: "random", want: StrategyRandom},
		{name: "round-robin", value: "round-robin", want: StrategyRoundRobin},
		{name: "trimmed and case-folded", value: "  ROUND-ROBIN ", want: StrategyRoundRobin},
		{name: "unknown", value: "weighted", wantErr: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			got, err := ParseSelectionStrategy(testCase.value)
			if testCase.wantErr {
				if !errors.Is(err, ErrUnknownSelectionStrategy) {
					t.Fatalf("ParseSelectionStrategy(%q) error = %v", testCase.value, err)
				}
				return
			}
			if err != nil || got != testCase.want {
				t.Fatalf(
					"ParseSelectionStrategy(%q) = %q, %v; want %q",
					testCase.value,
					got,
					err,
					testCase.want,
				)
			}
		})
	}
}

// TestSelectionWeightMatchesNodeRounding 验证额度权重与 Node 的 max(1, round(pct)) 同构。
func TestSelectionWeightMatchesNodeRounding(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		remaining usagecore.Remaining
		want      int
	}{
		{
			name:      "unknown keeps minimum weight",
			remaining: usagecore.UnknownRemaining(),
			want:      1,
		},
		{
			name:      "exhausted still participates",
			remaining: usagecore.Remaining{Known: true, BasisPoints: 0},
			want:      1,
		},
		{
			name:      "sub-percent rounds down to minimum",
			remaining: usagecore.Remaining{Known: true, BasisPoints: 49},
			want:      1,
		},
		{
			name:      "quarter",
			remaining: usagecore.Remaining{Known: true, BasisPoints: 2500},
			want:      25,
		},
		{
			name:      "rounds half up",
			remaining: usagecore.Remaining{Known: true, BasisPoints: 9950},
			want:      100,
		},
		{
			name:      "full",
			remaining: usagecore.Remaining{Known: true, BasisPoints: 10000},
			want:      100,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			if got := selectionWeight(testCase.remaining); got != testCase.want {
				t.Fatalf(
					"selectionWeight(%#v) = %d, want %d",
					testCase.remaining,
					got,
					testCase.want,
				)
			}
		})
	}
}

// TestWeightedStartSelectsByRemainingQuota 验证加权随机起点按剩余额度分配区间。
func TestWeightedStartSelectsByRemainingQuota(t *testing.T) {
	t.Parallel()

	first, _ := newRecruitmentCandidate(t, "codex", 1, "weight-first")
	second, _ := newRecruitmentCandidate(t, "codex", 2, "weight-second")
	third, _ := newRecruitmentCandidate(t, "codex", 3, "weight-third")
	candidates := accountapp.NewRoutingCandidates(
		[]accountapp.RoutingAccount{first, second, third},
	)
	// first 权重 100，second 权重 1（耗尽但仍有最小权重），third 权重 1（未知额度）。
	weights := staticWeightSource{weights: map[accountcore.AccountRef]usagecore.Remaining{
		first.Ref():  {Known: true, BasisPoints: 10000},
		second.Ref(): {Known: true, BasisPoints: 0},
	}}

	cases := []struct {
		name   string
		offset int
		want   int
	}{
		{name: "first bucket start", offset: 0, want: 0},
		{name: "first bucket end", offset: 99, want: 0},
		{name: "second bucket", offset: 100, want: 1},
		{name: "third bucket", offset: 101, want: 2},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			got := weightedStart(
				candidates,
				weights,
				func(limit int) int {
					if limit != 102 {
						t.Fatalf("randomIntN limit = %d, want 102", limit)
					}
					return testCase.offset
				},
			)
			if got != testCase.want {
				t.Fatalf("weightedStart() = %d, want %d", got, testCase.want)
			}
		})
	}
}

// TestWeightedStartDegradesWithoutInputs 验证缺权重源、随机源或候选时退化为固定起点。
func TestWeightedStartDegradesWithoutInputs(t *testing.T) {
	t.Parallel()

	first, _ := newRecruitmentCandidate(t, "codex", 1, "degrade-first")
	candidates := accountapp.NewRoutingCandidates([]accountapp.RoutingAccount{first})
	weights := staticWeightSource{}

	if got := weightedStart(candidates, nil, func(int) int { return 5 }); got != 0 {
		t.Fatalf("weightedStart(nil weights) = %d, want 0", got)
	}
	if got := weightedStart(candidates, weights, nil); got != 0 {
		t.Fatalf("weightedStart(nil random) = %d, want 0", got)
	}
	empty := accountapp.NewRoutingCandidates(nil)
	if got := weightedStart(empty, weights, func(int) int { return 0 }); got != 0 {
		t.Fatalf("weightedStart(empty) = %d, want 0", got)
	}
}

// TestNewRecruiterRequiresExplicitStrategy 验证选号策略必须显式传入，空值失败关闭。
func TestNewRecruiterRequiresExplicitStrategy(t *testing.T) {
	t.Parallel()

	source := &recruitmentCandidateSource{}
	resolver := newRecruitmentCredentialResolver(nil)
	base := Dependencies{
		Candidates:  source,
		Runtime:     &recruitmentEligibilitySource{},
		Credentials: resolver,
	}

	if _, err := NewRecruiter(base); !errors.Is(err, ErrUnknownSelectionStrategy) {
		t.Fatalf("NewRecruiter(empty strategy) error = %v, want ErrUnknownSelectionStrategy", err)
	}
	unknown := base
	unknown.Strategy = SelectionStrategy("weighted")
	if _, err := NewRecruiter(unknown); !errors.Is(err, ErrUnknownSelectionStrategy) {
		t.Fatalf("NewRecruiter(unknown strategy) error = %v, want ErrUnknownSelectionStrategy", err)
	}
	random := base
	random.Strategy = StrategyRandom
	recruiter, err := NewRecruiter(random)
	if err != nil || recruiter.Strategy() != StrategyRandom {
		t.Fatalf("NewRecruiter(random) = %v, %v", recruiter, err)
	}
}

// TestRecruiterRandomStrategyUsesWeightedStart 验证 random 策略经加权起点选号。
func TestRecruiterRandomStrategyUsesWeightedStart(t *testing.T) {
	t.Parallel()

	first, firstCredential := newRecruitmentCandidate(t, "codex", 1, "rand-first")
	second, secondCredential := newRecruitmentCandidate(t, "codex", 2, "rand-second")
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{first, second},
	}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			first.Ref():  {credential: firstCredential},
			second.Ref(): {credential: secondCredential},
		},
	)
	recruiter, err := NewRecruiter(Dependencies{
		Candidates:  source,
		Runtime:     &recruitmentEligibilitySource{},
		Credentials: resolver,
		Weights: staticWeightSource{weights: map[accountcore.AccountRef]usagecore.Remaining{
			first.Ref():  {Known: true, BasisPoints: 10000},
			second.Ref(): {Known: true, BasisPoints: 0},
		}},
		Strategy: StrategyRandom,
	})
	if err != nil {
		t.Fatalf("NewRecruiter() error = %v", err)
	}
	// 权重区间：first 100，second 1；偏移 100 落入 second。
	recruiter.randomIntN = func(limit int) int {
		if limit != 101 {
			t.Fatalf("randomIntN limit = %d, want 101", limit)
		}
		return 100
	}
	result, err := recruiter.Recruit(
		context.Background(),
		newTestRequest(t, "codex", "", 2),
		allowAllCredentialTransport{},
	)
	if err != nil || result.Account().Ref() != second.Ref() {
		t.Fatalf("Recruit() result=%#v error=%v, want second", result, err)
	}
}

// staticWeightSource 返回预置的账号剩余额度，用于确定性加权测试。
type staticWeightSource struct {
	weights map[accountcore.AccountRef]usagecore.Remaining
}

// AccountRemaining 返回预置剩余额度；未配置时视为未知。
func (source staticWeightSource) AccountRemaining(
	accountRef accountcore.AccountRef,
) usagecore.Remaining {
	return source.weights[accountRef]
}
