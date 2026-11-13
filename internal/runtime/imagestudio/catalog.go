package imagestudio

import (
	"context"
	"regexp"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/images"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
)

// AccountOverviewLister 读取账号概览快照。
type AccountOverviewLister interface {
	ListAccountOverviews(ctx context.Context) ([]accountapp.AccountOverview, error)
}

// AccountModelLister 读取全部账号的发现模型目录。
type AccountModelLister interface {
	ListAllAccountModels(ctx context.Context) (accountapp.AccountModelCatalog, error)
}

// RoutingExclusionReader 读取被排除通用路由的账号集合。
type RoutingExclusionReader interface {
	LoadRoutingExclusions(ctx context.Context) (map[string]bool, error)
}

// EligibilityChecker 判定账号与模型二元组的实时调度资格。
type EligibilityChecker interface {
	CheckEligibility(ctx context.Context, route runtimecore.ModelRoute) (runtimecore.Eligibility, error)
}

// CatalogDependencies 聚合构建工作台生图模型目录的只读依赖。
type CatalogDependencies struct {
	Accounts      AccountOverviewLister
	AccountModels AccountModelLister
	Exclusions    RoutingExclusionReader
	Runtime       EligibilityChecker
	Providers     *providers.Catalog
	Modalities    *modelsdev.Index
}

// CatalogCapabilities 描述前端渲染生图表单所需的模型能力矩阵。
type CatalogCapabilities struct {
	Generation        bool `json:"generation"`
	Edit              bool `json:"edit"`
	Mask              bool `json:"mask"`
	Multiple          bool `json:"multiple"`
	Size              bool `json:"size"`
	Quality           bool `json:"quality"`
	ResponseFormat    bool `json:"responseFormat"`
	MaxInputImages    int  `json:"maxInputImages"`
	Background        bool `json:"background"`
	OutputFormat      bool `json:"outputFormat"`
	OutputCompression bool `json:"outputCompression"`
	Moderation        bool `json:"moderation"`
}

// UnavailableReasonCount 统计同一不可用原因下的账号数量。
type UnavailableReasonCount struct {
	Reason string `json:"reason"`
	Count  int    `json:"count"`
}

// ModelEntry 描述 Image Studio 模型选择器中的单个模型选项。
type ModelEntry struct {
	Key                   string                   `json:"key"`
	ID                    string                   `json:"id"`
	Label                 string                   `json:"label"`
	Provider              string                   `json:"provider"`
	ProviderLabel         string                   `json:"providerLabel"`
	Priority              int                      `json:"priority"`
	Source                string                   `json:"source"`
	Capabilities          CatalogCapabilities      `json:"capabilities"`
	QualityOptions        []string                 `json:"qualityOptions"`
	AccountCount          int                      `json:"accountCount"`
	AvailableAccountCount int                      `json:"availableAccountCount"`
	UnavailableReasons    []UnavailableReasonCount `json:"unavailableReasons"`
}

type nativeModelMeta struct {
	ID       string
	Label    string
	Priority int
}

var (
	providerDisplayLabels = map[string]string{
		"agy":    "Antigravity",
		"codex":  "Codex",
		"gemini": "Gemini",
		"grok":   "Grok",
	}

	nativeModelMetas = map[string][]nativeModelMeta{
		"codex": {
			{ID: "gpt-image-2", Label: "GPT Image 2", Priority: 10},
		},
		"agy": {
			{ID: "gemini-3.1-flash-image", Label: "Gemini 3.1 Flash Image", Priority: 20},
			{ID: "gemini-2.5-flash-image", Label: "Gemini 2.5 Flash Image", Priority: 50},
		},
		"gemini": {
			{ID: "gemini-3.1-flash-image", Label: "Gemini 3.1 Flash Image", Priority: 20},
			{ID: "gemini-2.5-flash-image", Label: "Gemini 2.5 Flash Image", Priority: 50},
		},
		"grok": {
			{ID: "grok-imagine-image-2.0", Label: "Grok Imagine Image 2.0", Priority: 60},
			{ID: "grok-imagine-image-quality", Label: "Grok Imagine Image Quality", Priority: 65},
			{ID: "grok-imagine-image", Label: "Grok Imagine Image", Priority: 70},
		},
	}

	reGrokImageModel   = regexp.MustCompile(`(?i)^grok-(?:imagine-)?image(?:[-._].+)?$`)
	reGeminiImageModel = regexp.MustCompile(`(?i)^(?:google/)?gemini[-_/].*image(?:[-._].*)?$`)
	reNanoBananaModel  = regexp.MustCompile(`(?i)nano-?banana`)
)

// ImageModelBelongsToProvider 判断原生发现模型是否归属当前 OAuth Provider（与 Node 同步）。
func ImageModelBelongsToProvider(provider string, modelID string) bool {
	normProv := strings.ToLower(strings.TrimSpace(provider))
	normModel := strings.ToLower(strings.TrimSpace(modelID))
	if normModel == "" {
		return false
	}
	switch normProv {
	case "codex":
		return normModel == "gpt-image-2"
	case "grok":
		return reGrokImageModel.MatchString(normModel)
	case "agy", "gemini":
		return reGeminiImageModel.MatchString(normModel) || reNanoBananaModel.MatchString(normModel)
	default:
		return false
	}
}

func modelGeneratesImages(modalities *modelsdev.Index, providerID string, modelID string) bool {
	if modalities != nil {
		if m, found := modalities.LookupOrInferModalities(providerID, modelID); found {
			for _, out := range m.Output() {
				if strings.EqualFold(out, "image") {
					return true
				}
			}
			return false
		}
	}
	lower := strings.ToLower(strings.TrimSpace(modelID))
	return strings.Contains(lower, "gpt-image") ||
		strings.Contains(lower, "dall-e") ||
		strings.Contains(lower, "grok-imagine") ||
		strings.HasSuffix(lower, "-image") ||
		strings.Contains(lower, "-image-")
}

func toCatalogCaps(caps images.Capabilities) CatalogCapabilities {
	maxIn := caps.MaxInputImages
	if maxIn < 1 {
		maxIn = 1
	}
	return CatalogCapabilities{
		Generation:        caps.Generation,
		Edit:              caps.Edit,
		Mask:              caps.Mask,
		Multiple:          caps.Multiple,
		Size:              caps.Size,
		Quality:           caps.Quality,
		ResponseFormat:    caps.ResponseFormat,
		MaxInputImages:    maxIn,
		Background:        caps.Background,
		OutputFormat:      caps.OutputFormat,
		OutputCompression: caps.OutputCompression,
		Moderation:        caps.Moderation,
	}
}

func mergeCatalogCaps(dst *CatalogCapabilities, src CatalogCapabilities) {
	dst.Generation = dst.Generation || src.Generation
	dst.Edit = dst.Edit || src.Edit
	dst.Mask = dst.Mask || src.Mask
	dst.Multiple = dst.Multiple || src.Multiple
	dst.Size = dst.Size || src.Size
	dst.Quality = dst.Quality || src.Quality
	dst.ResponseFormat = dst.ResponseFormat || src.ResponseFormat
	if src.MaxInputImages > dst.MaxInputImages {
		dst.MaxInputImages = src.MaxInputImages
	}
	if dst.MaxInputImages < 1 {
		dst.MaxInputImages = 1
	}
	dst.Background = dst.Background || src.Background
	dst.OutputFormat = dst.OutputFormat || src.OutputFormat
	dst.OutputCompression = dst.OutputCompression || src.OutputCompression
	dst.Moderation = dst.Moderation || src.Moderation
}

// ListModels 装配 Image Studio 全部可选模型、能力声明与可用账号状态。
func ListModels(ctx context.Context, deps CatalogDependencies, providerFilter string) ([]ModelEntry, error) {
	filter := strings.ToLower(strings.TrimSpace(providerFilter))
	if filter == "auto" {
		filter = ""
	}

	exclusions := map[string]bool{}
	if deps.Exclusions != nil {
		if loaded, err := deps.Exclusions.LoadRoutingExclusions(ctx); err == nil && loaded != nil {
			exclusions = loaded
		}
	}

	overviews := []accountapp.AccountOverview{}
	if deps.Accounts != nil {
		loaded, err := deps.Accounts.ListAccountOverviews(ctx)
		if err != nil {
			return nil, err
		}
		overviews = loaded
	}

	discoveredByAccount := make(map[string][]string)
	if deps.AccountModels != nil {
		cat, err := deps.AccountModels.ListAllAccountModels(ctx)
		if err != nil {
			return nil, err
		}
		for _, set := range cat.Sets {
			ref := set.AccountRef.String()
			for _, m := range set.Models {
				if !m.IsValid() || !m.Effective() {
					continue
				}
				discoveredByAccount[ref] = append(discoveredByAccount[ref], m.ModelID().String())
			}
		}
	}

	type accumulator struct {
		key             string
		id              string
		label           string
		provider        string
		providerLabel   string
		priority        int
		sources         map[string]struct{}
		allCaps         CatalogCapabilities
		availCaps       CatalogCapabilities
		allQualities    map[string]struct{}
		availQualities  map[string]struct{}
		allAccounts     map[string]struct{}
		availAccounts   map[string]struct{}
		unavailByReason map[string]string
	}

	entries := make(map[string]*accumulator)
	ensureAcc := func(provider string, id string, label string, priority int) *accumulator {
		key := provider + ":" + id
		if existing, ok := entries[key]; ok {
			return existing
		}
		if label == "" {
			label = id
		}
		if priority <= 0 {
			priority = 500
		}
		provLabel := providerDisplayLabels[provider]
		if provLabel == "" && deps.Providers != nil {
			if def, found := deps.Providers.Get(provider); found && def.Presentation.Label != "" {
				provLabel = def.Presentation.Label
			}
		}
		if provLabel == "" {
			provLabel = provider
		}
		acc := &accumulator{
			key:             key,
			id:              id,
			label:           label,
			provider:        provider,
			providerLabel:   provLabel,
			priority:        priority,
			sources:         make(map[string]struct{}),
			allQualities:    make(map[string]struct{}),
			availQualities:  make(map[string]struct{}),
			allAccounts:     make(map[string]struct{}),
			availAccounts:   make(map[string]struct{}),
			unavailByReason: make(map[string]string),
		}
		entries[key] = acc
		return acc
	}

	resolveReason := func(ov accountapp.AccountOverview, ref accountcore.AccountRef, modelID string) string {
		if !ov.Account().Enabled() {
			return "disabled"
		}
		if !ov.HasCredential() {
			return "credential_missing"
		}
		if exclusions[ref.String()] {
			return "excluded"
		}
		if deps.Runtime != nil {
			route, err := runtimecore.NewModelRoute(ref, modelID)
			if err != nil {
				return "invalid_route"
			}
			elig, err := deps.Runtime.CheckEligibility(ctx, route)
			if err != nil {
				return "runtime_error"
			}
			if !elig.Eligible() {
				return string(elig.Status())
			}
		}
		return ""
	}

	recordAccount := func(acc *accumulator, ov accountapp.AccountOverview, source string, caps CatalogCapabilities, qualities []string) {
		if acc == nil {
			return
		}
		ref := ov.Account().Ref()
		refStr := ref.String()
		acc.allAccounts[refStr] = struct{}{}
		reason := resolveReason(ov, ref, acc.id)
		if reason == "" {
			acc.availAccounts[refStr] = struct{}{}
			mergeCatalogCaps(&acc.availCaps, caps)
			for _, q := range qualities {
				if q = strings.ToLower(strings.TrimSpace(q)); q != "" {
					acc.availQualities[q] = struct{}{}
				}
			}
		} else {
			acc.unavailByReason[refStr] = reason
		}
		acc.sources[source] = struct{}{}
		mergeCatalogCaps(&acc.allCaps, caps)
		for _, q := range qualities {
			if q = strings.ToLower(strings.TrimSpace(q)); q != "" {
				acc.allQualities[q] = struct{}{}
			}
		}
	}

	for _, ov := range overviews {
		acct := ov.Account()
		if !acct.IsValid() {
			continue
		}
		provider := strings.ToLower(strings.TrimSpace(acct.ProviderID()))
		if filter != "" && provider != filter {
			continue
		}
		authKind := strings.ToLower(strings.TrimSpace(ov.AuthKind()))
		isAPIKey := authKind == "api_key" || authKind == "api-key"
		if !isAPIKey {
			for _, meta := range nativeModelMetas[provider] {
				if caps, ok := images.NativeCapabilities(provider, meta.ID); ok {
					recordAccount(
						ensureAcc(provider, meta.ID, meta.Label, meta.Priority),
						ov,
						"native",
						toCatalogCaps(caps),
						images.NativeQualityOptions(provider, meta.ID),
					)
				}
			}
		}
		for _, modelID := range discoveredByAccount[acct.Ref().String()] {
			if !modelGeneratesImages(deps.Modalities, provider, modelID) {
				continue
			}
			if isAPIKey {
				caps, _ := images.NativeCapabilities("passthrough", modelID)
				recordAccount(
					ensureAcc(provider, modelID, "", 500),
					ov,
					"discovered",
					toCatalogCaps(caps),
					images.NativeQualityOptions("passthrough", modelID),
				)
				continue
			}
			if !ImageModelBelongsToProvider(provider, modelID) {
				continue
			}
			caps, ok := images.NativeCapabilities(provider, modelID)
			if !ok {
				continue
			}
			recordAccount(
				ensureAcc(provider, modelID, "", 500),
				ov,
				"discovered",
				toCatalogCaps(caps),
				images.NativeQualityOptions(provider, modelID),
			)
		}
	}

	out := make([]ModelEntry, 0, len(entries))
	for _, acc := range entries {
		caps := acc.allCaps
		qualSet := acc.allQualities
		if len(acc.availAccounts) > 0 {
			caps = acc.availCaps
			qualSet = acc.availQualities
		}
		if caps.MaxInputImages < 1 {
			caps.MaxInputImages = 1
		}

		sources := make([]string, 0, len(acc.sources))
		for s := range acc.sources {
			sources = append(sources, s)
		}
		sort.Strings(sources)

		qualities := make([]string, 0, len(qualSet))
		for q := range qualSet {
			qualities = append(qualities, q)
		}
		sort.Strings(qualities)

		reasonCountsMap := make(map[string]int)
		for _, r := range acc.unavailByReason {
			if r != "" {
				reasonCountsMap[r]++
			}
		}
		reasonCounts := make([]UnavailableReasonCount, 0, len(reasonCountsMap))
		for r, c := range reasonCountsMap {
			reasonCounts = append(reasonCounts, UnavailableReasonCount{Reason: r, Count: c})
		}
		sort.Slice(reasonCounts, func(i, j int) bool {
			if reasonCounts[j].Count != reasonCounts[i].Count {
				return reasonCounts[j].Count < reasonCounts[i].Count
			}
			return reasonCounts[i].Reason < reasonCounts[j].Reason
		})

		out = append(out, ModelEntry{
			Key:                   acc.key,
			ID:                    acc.id,
			Label:                 acc.label,
			Provider:              acc.provider,
			ProviderLabel:         acc.providerLabel,
			Priority:              acc.priority,
			Source:                strings.Join(sources, "+"),
			Capabilities:          caps,
			QualityOptions:        qualities,
			AccountCount:          len(acc.allAccounts),
			AvailableAccountCount: len(acc.availAccounts),
			UnavailableReasons:    reasonCounts,
		})
	}

	sort.Slice(out, func(i, j int) bool {
		if out[i].Priority != out[j].Priority {
			return out[i].Priority < out[j].Priority
		}
		if out[i].Provider != out[j].Provider {
			return out[i].Provider < out[j].Provider
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// ResolveDefaultModelKey 返回首选的可用默认模型 Key。
func ResolveDefaultModelKey(models []ModelEntry) string {
	for _, m := range models {
		if m.AvailableAccountCount > 0 {
			return m.Key
		}
	}
	if len(models) > 0 {
		return models[0].Key
	}
	return ""
}
