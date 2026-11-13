// Package chatattachments 定义聊天附件能力的跨端合同。
//
// 这里是唯一人工维护的定义源：Go 处理器直接引用本包常量，Node 与 Web 通过
// `go generate ./contracts/chatattachments` 生成的数据投影读取同一组数值。
// 新增附件类型、调整大小上限或大段粘贴阈值时，只改本文件并重新生成。
package chatattachments

//go:generate go run ../../cmd/chat-attachment-manifest --root ../..

const (
	// MaxFiles 是单轮最多附加的文件数。
	MaxFiles = 8

	// LargePasteChars 是粘贴文本自动转附件阈值的默认值与允许区间。
	DefaultLargePasteChars = 200
	MinLargePasteChars     = 50
	MaxLargePasteChars     = 100000

	// 单文件与单轮总大小上限（字节）。maxTotalBytes 是最大的合法解码批次，
	// 覆盖单个视频的情况。
	MaxImageBytes    = 10 * 1024 * 1024
	MaxDocumentBytes = 16 * 1024 * 1024
	MaxVideoBytes    = 100 * 1024 * 1024
	MaxTotalBytes    = 128 * 1024 * 1024
)

// LargePasteChars 是 WebUI 大段粘贴转文本附件的阈值配置。
type LargePasteChars struct {
	Default int `json:"default"`
	Min     int `json:"min"`
	Max     int `json:"max"`
}

// Limits 是 Node 与 Web 共用的附件限制投影。
type Limits struct {
	MaxFiles            int               `json:"maxFiles"`
	LargePasteChars     LargePasteChars   `json:"largePasteChars"`
	MaxImageBytes       int64             `json:"maxImageBytes"`
	MaxDocumentBytes    int64             `json:"maxDocumentBytes"`
	MaxVideoBytes       int64             `json:"maxVideoBytes"`
	MaxTotalBytes       int64             `json:"maxTotalBytes"`
	ImageTypes          []string          `json:"imageTypes"`
	VideoTypes          []string          `json:"videoTypes"`
	VideoExtensionTypes map[string]string `json:"videoExtensionTypes"`
	TextExtensions      []string          `json:"textExtensions"`
}

// Default 返回权威附件限制。每次调用都返回独立切片，避免调用方修改共享状态。
func Default() Limits {
	return Limits{
		MaxFiles: MaxFiles,
		LargePasteChars: LargePasteChars{
			Default: DefaultLargePasteChars,
			Min:     MinLargePasteChars,
			Max:     MaxLargePasteChars,
		},
		MaxImageBytes:    MaxImageBytes,
		MaxDocumentBytes: MaxDocumentBytes,
		MaxVideoBytes:    MaxVideoBytes,
		MaxTotalBytes:    MaxTotalBytes,
		ImageTypes:       []string{"image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"},
		VideoTypes:       []string{"video/mp4", "video/x-m4v", "video/quicktime", "video/webm"},
		VideoExtensionTypes: map[string]string{
			"mp4":  "video/mp4",
			"m4v":  "video/x-m4v",
			"mov":  "video/quicktime",
			"webm": "video/webm",
		},
		TextExtensions: []string{
			"md", "markdown", "mdx", "txt", "text", "log", "csv", "tsv", "json", "jsonl",
			"yaml", "yml", "toml", "xml", "html", "htm", "css", "scss", "less", "js", "jsx",
			"ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c",
			"h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "ps1", "sql", "r", "vue",
			"svelte", "ini", "cfg", "conf", "properties", "tex", "rst", "diff", "patch",
		},
	}
}
