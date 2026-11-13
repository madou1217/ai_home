package imagestudio

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
	"github.com/madou1217/ai_home/internal/adapters/images"
	"github.com/madou1217/ai_home/internal/transport/http/imagesapi"
)

const studioRecordTimeout = 5 * time.Second

// StudioAccountFailureCodes 列举图片实体化阶段需计入账号健康度/冷却的原因码。
var StudioAccountFailureCodes = map[string]struct{}{
	"empty_image_output":                  {},
	"image_asset_fetch_failed":            {},
	"image_asset_host_resolution_failed":  {},
	"image_asset_read_timeout":            {},
	"image_asset_redirect_invalid":        {},
	"image_asset_redirect_limit":          {},
	"image_asset_too_large":               {},
	"image_asset_url_blocked":             {},
	"image_output_missing":                {},
	"invalid_image_output":                {},
	"invalid_image_output_url":            {},
}

// RunSourceInput 描述单条前端传入的编辑底图来源（二选一）。
type RunSourceInput struct {
	AssetID string `json:"assetId,omitempty"`
	Image   string `json:"image,omitempty"`
}

// RunRequest 描述一次 Image Studio 生成或编辑请求的完整参数。
type RunRequest struct {
	ModelKey          string           `json:"modelKey"`
	Provider          string           `json:"provider"`
	Model             string           `json:"model"`
	Mode              string           `json:"mode"`
	Prompt            string           `json:"prompt"`
	ParentRevisionID  string           `json:"parentRevisionId"`
	N                 *int             `json:"n"`
	Size              string           `json:"size"`
	Quality           string           `json:"quality"`
	Background        string           `json:"background"`
	OutputFormat      string           `json:"output_format"`
	OutputCompression *int             `json:"output_compression"`
	Moderation        string           `json:"moderation"`
	Sources           []RunSourceInput `json:"sources"`
	HasSources        bool             `json:"-"`
	SourceAssetID     string           `json:"sourceAssetId"`
	Image             string           `json:"image"`
	MaskAssetID       string           `json:"maskAssetId"`
	Mask              string           `json:"mask"`
}

// RunResult 是成功运行后的完整会话快照与修订 ID。
type RunResult struct {
	Session    Session
	RevisionID string
}

// ServiceDependencies 汇总 Image Studio 服务所需全部基础设施依赖。
type ServiceDependencies struct {
	Store    *Store
	Catalog  CatalogDependencies
	Registry images.Registry
	Accounts images.AccountSource
	HTTP     images.HTTPDoer
	Fetcher  images.ImageFetcher
	Usage    imagesapi.UsageRecorder
	Outcomes imagesapi.ImageOutcomes
	Now      func() time.Time
}

// Service 编排工作台模型目录、会话仓储与上游生图/编辑运行。
type Service struct {
	store    *Store
	catalog  CatalogDependencies
	registry images.Registry
	accounts images.AccountSource
	httpDoer images.HTTPDoer
	fetcher  images.ImageFetcher
	usage    imagesapi.UsageRecorder
	outcomes imagesapi.ImageOutcomes
	now      func() time.Time
}

// NewService 构造线程安全的 Image Studio 领域服务。
func NewService(deps ServiceDependencies) (*Service, error) {
	if deps.Store == nil {
		return nil, NewError(503, "image_studio_store_unavailable", "image Studio store is not configured")
	}
	nowFn := deps.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	fetcher := deps.Fetcher
	if fetcher == nil {
		fetcher = images.NewFetcher(deps.HTTP)
	}
	return &Service{
		store:    deps.Store,
		catalog:  deps.Catalog,
		registry: deps.Registry,
		accounts: deps.Accounts,
		httpDoer: deps.HTTP,
		fetcher:  fetcher,
		usage:    deps.Usage,
		outcomes: deps.Outcomes,
		now:      nowFn,
	}, nil
}

// Store 返回关联的会话/资产 SQLite 仓储。
func (svc *Service) Store() *Store {
	return svc.store
}

// ListModels 返回工作台当前可用模型矩阵及默认首选 Key。
func (svc *Service) ListModels(ctx context.Context, providerFilter string) ([]ModelEntry, string, error) {
	models, err := ListModels(ctx, svc.catalog, providerFilter)
	if err != nil {
		return nil, "", err
	}
	if models == nil {
		models = []ModelEntry{}
	}
	return models, ResolveDefaultModelKey(models), nil
}

// ExecuteRun 校验参数、创建 running 修订、调用上游策略、持久化输出图片并更新账号统计。
func (svc *Service) ExecuteRun(ctx context.Context, sessionID string, req RunRequest) (RunResult, error) {
	models, _, err := svc.ListModels(ctx, "")
	if err != nil {
		return RunResult{}, err
	}
	selected, err := selectCatalogModel(req, models)
	if err != nil {
		return RunResult{}, err
	}

	mode := "generation"
	if strings.EqualFold(strings.TrimSpace(req.Mode), "edit") {
		mode = "edit"
	}
	sourcesInput, err := normalizeStudioSources(req)
	if err != nil {
		return RunResult{}, err
	}
	if mode == "generation" && (len(sourcesInput) > 0 || strings.TrimSpace(req.Mask) != "" || strings.TrimSpace(req.MaskAssetID) != "") {
		return RunResult{}, NewError(400, "image_input_requires_edit", "source images and masks require edit mode")
	}
	if strings.TrimSpace(req.MaskAssetID) != "" && strings.TrimSpace(req.Mask) != "" {
		return RunResult{}, NewError(400, "ambiguous_mask_input", "choose either maskAssetId or mask, not both")
	}

	type resolvedSource struct {
		assetID   string
		mime      string
		bytes     []byte
		dataURL   string
		fromStore bool
	}
	resolvedSources := make([]resolvedSource, 0, len(sourcesInput))
	hasStoredSource := false
	for _, src := range sourcesInput {
		aid := strings.TrimSpace(src.AssetID)
		rawImg := strings.TrimSpace(src.Image)
		if aid != "" && rawImg != "" {
			return RunResult{}, NewError(400, "ambiguous_image_input", "each source must use either assetId or image")
		}
		if aid != "" {
			asset, dataBytes, readErr := svc.store.ReadAsset(ctx, sessionID, aid)
			if readErr != nil {
				return RunResult{}, readErr
			}
			hasStoredSource = true
			b64 := base64.StdEncoding.EncodeToString(dataBytes)
			resolvedSources = append(resolvedSources, resolvedSource{
				assetID:   aid,
				mime:      asset.MIME,
				bytes:     dataBytes,
				dataURL:   "data:" + asset.MIME + ";base64," + b64,
				fromStore: true,
			})
			continue
		}
		if rawImg != "" {
			resolvedSources = append(resolvedSources, resolvedSource{
				dataURL: rawImg,
			})
			continue
		}
		return RunResult{}, NewError(400, "invalid_image_source", "each source must include assetId or image")
	}

	maskDataURL := ""
	hasStoredMask := false
	if maskAID := strings.TrimSpace(req.MaskAssetID); maskAID != "" {
		asset, dataBytes, readErr := svc.store.ReadAsset(ctx, sessionID, maskAID)
		if readErr != nil {
			return RunResult{}, readErr
		}
		hasStoredMask = true
		maskDataURL = "data:" + asset.MIME + ";base64," + base64.StdEncoding.EncodeToString(dataBytes)
	} else if strings.TrimSpace(req.Mask) != "" {
		maskDataURL = strings.TrimSpace(req.Mask)
	}

	nVal := 1
	if req.N != nil {
		nVal = *req.N
	}
	execMap := map[string]any{
		"provider":        selected.Provider,
		"model":           selected.ID,
		"prompt":          strings.TrimSpace(req.Prompt),
		"n":               nVal,
		"response_format": "b64_json",
		"session_id":      sessionID,
	}
	if s := strings.TrimSpace(req.Size); s != "" {
		execMap["size"] = s
	}
	if q := strings.TrimSpace(req.Quality); q != "" {
		execMap["quality"] = q
	}
	if b := strings.TrimSpace(req.Background); b != "" {
		execMap["background"] = b
	}
	if f := strings.TrimSpace(req.OutputFormat); f != "" {
		execMap["output_format"] = f
	}
	if req.OutputCompression != nil {
		execMap["output_compression"] = *req.OutputCompression
	}
	if m := strings.TrimSpace(req.Moderation); m != "" {
		execMap["moderation"] = m
	}
	if len(resolvedSources) > 0 {
		imgPayloads := make([]map[string]string, 0, len(resolvedSources))
		for _, src := range resolvedSources {
			imgPayloads = append(imgPayloads, map[string]string{"image_url": src.dataURL})
		}
		execMap["images"] = imgPayloads
	}
	if maskDataURL != "" {
		execMap["mask"] = maskDataURL
	}

	execJSON, err := json.Marshal(execMap)
	if err != nil {
		return RunResult{}, err
	}
	pathname := imagegeneration.PathGenerations
	if mode == "edit" {
		pathname = imagegeneration.PathEdits
	}
	parseOpts := imagegeneration.Options{}
	if hasStoredSource {
		parseOpts.MaxImageBytes = MaxStudioAssetBytes
	}
	if hasStoredMask {
		parseOpts.MaxMaskBytes = MaxStudioAssetBytes
	}
	parsedReq, parseErr := imagegeneration.Parse(execJSON, pathname, parseOpts)
	if parseErr != nil {
		if !imagegeneration.IsPassthroughCandidateError(parseErr) || selected.Source != "discovered" {
			return RunResult{}, mapRequestParseError(parseErr)
		}
		lenient, lenientErr := imagegeneration.ParsePassthrough(execJSON, pathname, parseOpts)
		if lenientErr != nil {
			return RunResult{}, mapRequestParseError(parseErr)
		}
		parsedReq = lenient
	}

	revSources := make([]RevisionSourceInput, 0, len(resolvedSources))
	for i, src := range resolvedSources {
		if src.fromStore {
			revSources = append(revSources, RevisionSourceInput{AssetID: src.assetID})
			continue
		}
		if i < len(parsedReq.Images) {
			decodedBytes, decErr := base64.StdEncoding.DecodeString(parsedReq.Images[i].Data)
			if decErr != nil {
				return RunResult{}, NewError(400, "invalid_image_input", "source image data is invalid base64")
			}
			revSources = append(revSources, RevisionSourceInput{
				Image: &StoredImage{
					MIME:  string(parsedReq.Images[i].MIME),
					Bytes: decodedBytes,
				},
			})
		}
	}

	var maskStoreImg *StoredImage
	if !hasStoredMask && parsedReq.Mask != nil {
		decodedMask, decErr := base64.StdEncoding.DecodeString(parsedReq.Mask.Data)
		if decErr != nil {
			return RunResult{}, NewError(400, "invalid_mask_input", "mask image data is invalid base64")
		}
		maskStoreImg = &StoredImage{
			MIME:  string(parsedReq.Mask.MIME),
			Bytes: decodedMask,
		}
	}

	_, startedRev, err := svc.store.BeginRevision(ctx, sessionID, BeginRevisionInput{
		Mode:             mode,
		Provider:         selected.Provider,
		Model:            selected.ID,
		ModelKey:         selected.Key,
		Prompt:           parsedReq.Prompt,
		ParentRevisionID: req.ParentRevisionID,
		Sources:          revSources,
		MaskAssetID:      req.MaskAssetID,
		MaskImage:        maskStoreImg,
		Parameters: RevisionParameters{
			N:                 parsedReq.N,
			Size:              parsedReq.Size,
			Quality:           parsedReq.Quality,
			Background:        parsedReq.Background,
			OutputFormat:      parsedReq.OutputFormat,
			OutputCompression: parsedReq.OutputCompression,
			Moderation:        parsedReq.Moderation,
		},
	})
	if err != nil {
		return RunResult{}, err
	}

	revisionID := startedRev.ID
	var execution images.Execution
	hasExecution := false
	failAndRecord := func(cause error) error {
		mapped := mapExecutionError(cause)
		if revisionID != "" {
			_, _, _ = svc.store.FailRevision(context.WithoutCancel(ctx), sessionID, revisionID, mapped)
		}
		if hasExecution && svc.outcomes != nil {
			if _, ok := StudioAccountFailureCodes[mapped.Code]; ok {
				rCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), studioRecordTimeout)
				svc.outcomes.RecordImageFailure(rCtx, execution.Account.AccountRef, parsedReq.Model, mapped)
				cancel()
			}
		}
		return mapped
	}

	if svc.accounts == nil {
		return RunResult{}, failAndRecord(NewError(503, "no_available_account", "image account source is not configured"))
	}

	execOpts := images.ExecuteOptions{HTTP: svc.httpDoer}
	if svc.outcomes != nil {
		execOpts.AttemptFailure = func(account images.Account, model string, attemptErr error) {
			rCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), studioRecordTimeout)
			defer cancel()
			svc.outcomes.RecordImageFailure(rCtx, account.AccountRef, model, attemptErr)
		}
	}
	execution, err = images.Execute(ctx, svc.registry, svc.accounts, selected.Provider, parsedReq, execOpts)
	if err != nil {
		return RunResult{}, failAndRecord(err)
	}
	hasExecution = true

	svc.recordUsage(ctx, execution, parsedReq.Model)

	materialized, err := MaterializeOutputs(ctx, execution, svc.fetcher, defaultRemoteFetchTimeout)
	if err != nil {
		return RunResult{}, failAndRecord(err)
	}

	if svc.outcomes != nil {
		rCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), studioRecordTimeout)
		svc.outcomes.RecordImageSuccess(rCtx, execution.Account.AccountRef, parsedReq.Model, svc.now())
		cancel()
	}

	completedSession, _, err := svc.store.CompleteRevision(
		context.WithoutCancel(ctx),
		sessionID,
		revisionID,
		execution.Account.AccountRef,
		materialized,
	)
	if err != nil {
		return RunResult{}, failAndRecord(err)
	}
	revisionID = ""
	return RunResult{
		Session:    completedSession,
		RevisionID: startedRev.ID,
	}, nil
}

func (svc *Service) recordUsage(ctx context.Context, execution images.Execution, model string) {
	if svc.usage == nil {
		return
	}
	tokens, ok := execution.Result.UsageTokens()
	if !ok {
		return
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:       tokens.InputTokens,
		OutputTokens:      tokens.OutputTokens,
		CachedInputTokens: tokens.CachedTokens,
		ReasoningTokens:   tokens.ReasoningTokens,
	})
	if err != nil {
		usage, err = inference.NewUsage(inference.UsageInput{
			InputTokens:  tokens.InputTokens,
			OutputTokens: tokens.OutputTokens,
		})
	}
	if err != nil || usage.TotalTokens() == 0 {
		return
	}
	rCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), studioRecordTimeout)
	defer cancel()
	svc.usage.RecordImageUsage(rCtx, execution.Account.AccountRef, model, usage, svc.now())
}

func selectCatalogModel(req RunRequest, models []ModelEntry) (ModelEntry, error) {
	modelKey := strings.TrimSpace(req.ModelKey)
	provider := strings.ToLower(strings.TrimSpace(req.Provider))
	model := strings.TrimSpace(req.Model)
	if modelKey != "" && (provider == "" || model == "") {
		if idx := strings.IndexByte(modelKey, ':'); idx > 0 {
			if provider == "" {
				provider = strings.ToLower(strings.TrimSpace(modelKey[:idx]))
			}
			if model == "" {
				model = strings.TrimSpace(modelKey[idx+1:])
			}
		}
	}
	key := provider + ":" + model
	for _, entry := range models {
		if entry.Key == key {
			return entry, nil
		}
	}
	return ModelEntry{}, NewError(400, "image_studio_model_not_found", "image model "+key+" is not available in the Studio catalog")
}

func normalizeStudioSources(req RunRequest) ([]RunSourceInput, error) {
	hasLegacy := strings.TrimSpace(req.SourceAssetID) != "" || strings.TrimSpace(req.Image) != ""
	if req.HasSources && hasLegacy {
		return nil, NewError(400, "ambiguous_image_input", "choose either sources or legacy image input fields")
	}
	if req.HasSources {
		return req.Sources, nil
	}
	if !hasLegacy {
		return nil, nil
	}
	return []RunSourceInput{{
		AssetID: req.SourceAssetID,
		Image:   req.Image,
	}}, nil
}

func mapRequestParseError(err error) *Error {
	if reqErr, ok := imagegeneration.AsError(err); ok {
		status := reqErr.StatusCode
		if status <= 0 {
			status = 400
		}
		return NewError(status, reqErr.Code, reqErr.Detail)
	}
	return NewError(400, "invalid_request", err.Error())
}

func mapExecutionError(err error) *Error {
	if err == nil {
		return NewError(500, "image_generation_failed", "image generation failed")
	}
	var studioErr *Error
	if errors.As(err, &studioErr) {
		return studioErr
	}
	if imgErr, ok := images.AsError(err); ok {
		status := imgErr.StatusCode
		if status <= 0 {
			status = 502
		}
		return NewError(status, imgErr.Code, imgErr.Detail)
	}
	return NewError(502, "image_generation_failed", err.Error())
}
