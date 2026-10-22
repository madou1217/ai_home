package inference

import "testing"

// tiers 返回升序阶梯的值列表（对齐入参），built 返回同一集合的阶梯对象（测试断言用）。
func tiers(values ...ReasoningEffort) []ReasoningEffort { return values }

func built(values ...ReasoningEffort) effortLadder { return ladderOf(values) }

// TestAlignReasoningEffortFollowsTheRankLadder 锁住倒排配对的两个原始例子：
// 目标三档 / 发送方五档 → 顶端对齐、底部收敛、不轮空；发送方只有两档 → 高两档平移、
// 目标最低档不被选中。
func TestAlignReasoningEffortFollowsTheRankLadder(t *testing.T) {
	t.Parallel()
	model := tiers(ReasoningEffortLow, ReasoningEffortMedium, ReasoningEffortHigh)
	sender := tiers(
		ReasoningEffortNone,
		ReasoningEffortMinimal,
		ReasoningEffortLow,
		ReasoningEffortMedium,
		ReasoningEffortHigh,
	)
	for _, test := range []struct {
		requested ReasoningEffort
		want      ReasoningEffort
	}{
		{ReasoningEffortHigh, ReasoningEffortHigh},
		{ReasoningEffortMedium, ReasoningEffortMedium},
		{ReasoningEffortLow, ReasoningEffortLow},
		{ReasoningEffortMinimal, ReasoningEffortLow},
		{ReasoningEffortNone, ReasoningEffortLow},
	} {
		got, ok := AlignReasoningEffort(test.requested, sender, model)
		if !ok || got != test.want {
			t.Fatalf("AlignReasoningEffort(%q) = (%q, %v), want %q", test.requested, got, ok, test.want)
		}
	}

	// 发送方只能表达两档时，两档整体上移到目标的最高两档（顶端对齐），
	// 目标最低档不再被任何请求选中。
	narrowSender := tiers(ReasoningEffortMinimal, ReasoningEffortLow)
	if got, ok := AlignReasoningEffort(ReasoningEffortLow, narrowSender, model); !ok || got != ReasoningEffortHigh {
		t.Fatalf("narrow sender low = (%q, %v), want high", got, ok)
	}
	if got, ok := AlignReasoningEffort(ReasoningEffortMinimal, narrowSender, model); !ok || got != ReasoningEffortMedium {
		t.Fatalf("narrow sender minimal = (%q, %v), want medium", got, ok)
	}
	// 发送方档位未知时按目标阶梯自身对齐：受支持的档位原样通过，不做整体位移。
	if got, ok := AlignReasoningEffort(ReasoningEffortMedium, nil, model); !ok || got != ReasoningEffortMedium {
		t.Fatalf("unknown sender medium = (%q, %v), want medium", got, ok)
	}
}

// TestAlignReasoningEffortIsMonotonicAndIdempotent 保证两条硬性质：
// 更强的请求不会被压成更弱（单调），已对齐的值再对齐不变（幂等）。
func TestAlignReasoningEffortIsMonotonicAndIdempotent(t *testing.T) {
	t.Parallel()
	model := built(ReasoningEffortLow, ReasoningEffortHigh, ReasoningEffortMax)
	previous := -1
	for _, requested := range canonicalEffortLadder.sorted {
		aligned, ok := AlignReasoningEffort(requested, nil, model.sorted)
		if !ok {
			t.Fatalf("%q must align against a non-empty ladder", requested)
		}
		position := model.rank[aligned]
		if position < previous {
			t.Fatalf("%q aligned to %q, weaker than the previous request", requested, aligned)
		}
		previous = position
		again, ok := AlignReasoningEffort(aligned, nil, model.sorted)
		if !ok || again != aligned {
			t.Fatalf("realigning %q changed it to %q", aligned, again)
		}
	}
}

// TestAlignReasoningEffortKeepsEveryModelTierReachable 验证「不轮空」：
// 发送方档位不少于目标档位时，目标阶梯的每一档都能被某个请求命中。
func TestAlignReasoningEffortKeepsEveryModelTierReachable(t *testing.T) {
	t.Parallel()
	model := built(ReasoningEffortLow, ReasoningEffortMedium, ReasoningEffortHigh, ReasoningEffortMax)
	reached := map[ReasoningEffort]bool{}
	for _, requested := range canonicalEffortLadder.sorted {
		aligned, ok := AlignReasoningEffort(requested, nil, model.sorted)
		if !ok {
			t.Fatalf("%q must align", requested)
		}
		reached[aligned] = true
	}
	for _, tier := range model.sorted {
		if !reached[tier] {
			t.Fatalf("model tier %q is unreachable", tier)
		}
	}
}

// TestAlignReasoningEffortReportsUnusableLadders 明确三种失败语义：
// 没有强度意图、目标没有档位、请求档位不在枚举里。
func TestAlignReasoningEffortReportsUnusableLadders(t *testing.T) {
	t.Parallel()
	model := tiers(ReasoningEffortLow, ReasoningEffortHigh)
	if _, ok := AlignReasoningEffort("", nil, model); ok {
		t.Fatal("an absent effort must not be aligned into one")
	}
	if _, ok := AlignReasoningEffort(ReasoningEffortHigh, nil, nil); ok {
		t.Fatal("a model without tiers must report failure instead of inventing one")
	}
	if _, ok := AlignReasoningEffort("turbo", nil, model); ok {
		t.Fatal("an unknown effort must not be aligned")
	}
	// 目录里的未知档位被丢弃，而不是让整条对齐失败。
	if got, ok := AlignReasoningEffort(ReasoningEffortHigh, nil,
		tiers("turbo", ReasoningEffortLow, ReasoningEffortHigh)); !ok || got != ReasoningEffortHigh {
		t.Fatalf("unknown catalog tiers must be dropped, got (%q, %v)", got, ok)
	}
}

// TestAlignReasoningEffortHandlesSparseModelLadders 覆盖目标阶梯在 Canonical 全序上有空洞的
// 情况（目录里确实存在只有 [medium, max] 这种组合的模型）：落点必须向下收敛到最近的可用档。
func TestAlignReasoningEffortHandlesSparseModelLadders(t *testing.T) {
	t.Parallel()
	sparse := tiers(ReasoningEffortMedium, ReasoningEffortMax)
	// 发送方档位未知时按目标阶梯对齐：high 落在 medium 与 max 之间，向上收敛到 max
	// ——宁可给足强度，也不把用户明确要求的 high 静默降成 medium。
	if got, ok := AlignReasoningEffort(ReasoningEffortHigh, nil, sparse); !ok || got != ReasoningEffortMax {
		t.Fatalf("high against [medium max] = (%q, %v), want max", got, ok)
	}
	if got, ok := AlignReasoningEffort(ReasoningEffortMinimal, nil, sparse); !ok || got != ReasoningEffortMedium {
		t.Fatalf("minimal against [medium max] = (%q, %v), want medium", got, ok)
	}
	if got, ok := AlignReasoningEffort(ReasoningEffortMax, nil, sparse); !ok || got != ReasoningEffortMax {
		t.Fatalf("max against [medium max] = (%q, %v), want max", got, ok)
	}
}

func TestReasoningConfigWithEffortKeepsModeAndBudget(t *testing.T) {
	t.Parallel()
	budget, err := NewBudgetReasoningWithEffort(4096, ReasoningSummaryAuto, ReasoningEffortLow)
	if err != nil {
		t.Fatal(err)
	}
	aligned, err := budget.WithEffort(ReasoningEffortMax)
	if err != nil {
		t.Fatal(err)
	}
	if aligned.Mode() != ReasoningModeBudget || aligned.BudgetTokens() != 4096 ||
		aligned.Effort() != ReasoningEffortMax || aligned.Summary() != ReasoningSummaryAuto {
		t.Fatalf("WithEffort must keep mode/budget/summary: %+v", aligned)
	}
	if _, err := budget.WithEffort("turbo"); err == nil {
		t.Fatal("an unknown effort must be rejected")
	}
}
