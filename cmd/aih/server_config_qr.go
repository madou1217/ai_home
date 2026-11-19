package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
	qrcode "github.com/skip2/go-qrcode"
)

const (
	managementKeyQRVersion = 1
	managementKeyQRType    = "aih-server-credentials"
	minManagementKeyLength = 32
	maxManagementKeyLength = 4096
)

func printServerConfigQR(ctx context.Context, home, qrURL string, runtime commandRuntime) error {
	config, err := webuiserverconfigapi.ReadFullConfig(ctx, home)
	if err != nil {
		return err
	}
	key := strings.TrimSpace(config.ManagementKey)
	if len(key) < minManagementKeyLength || len(key) > maxManagementKeyLength || strings.ContainsAny(key, "\r\n\x00") {
		return fmt.Errorf("Management Key 必须为 %d-%d 个字符，且不能包含换行", minManagementKeyLength, maxManagementKeyLength)
	}
	endpoint := strings.TrimSpace(qrURL)
	if endpoint == "" {
		endpoint = resolveQRAdvertisedEndpoint(config)
	}
	endpoint, err = normalizeQREndpoint(endpoint)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{
		"v": managementKeyQRVersion, "type": managementKeyQRType,
		"endpoint": endpoint, "managementKey": key,
	})
	if err != nil {
		return err
	}
	code, err := qrcode.New(string(payload), qrcode.Medium)
	if err != nil {
		return fmt.Errorf("Server URL 或 Management Key 太长，超过单个二维码容量，请使用手动输入")
	}
	code.DisableBorder = true
	matrix := code.Bitmap()
	const quietZone = 4
	size := len(matrix) + quietZone*2
	for row := 0; row < size; row += 2 {
		var line strings.Builder
		line.WriteString("\x1b[30;47m")
		for column := 0; column < size; column++ {
			top := qrCell(matrix, column-quietZone, row-quietZone, len(matrix))
			bottom := qrCell(matrix, column-quietZone, row+1-quietZone, len(matrix))
			palette := " ▄▀█"
			index := 0
			if top {
				index += 2
			}
			if bottom {
				index++
			}
			line.WriteRune([]rune(palette)[index])
		}
		line.WriteString("\x1b[0m")
		_, _ = fmt.Fprintln(runtime.stdout, line.String())
	}
	_, _ = fmt.Fprintf(runtime.stdout, "\n扫码后在手机 Server Setup 中确认并提交。Server URL：%s\n", endpoint)
	return nil
}

func qrCell(matrix [][]bool, x, y, size int) bool {
	if x < 0 || y < 0 || x >= size || y >= size {
		return false
	}
	return matrix[y][x]
}

func resolveQRAdvertisedEndpoint(config webuiserverconfigapi.ConfigView) string {
	host := strings.TrimSpace(config.Host)
	if host == "" || host == "127.0.0.1" || host == "0.0.0.0" || host == "::1" || host == "localhost" {
		if lan := firstLANIPv4(); lan != "" {
			host = lan
		}
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	port := config.Port
	if port <= 0 || port > 65535 {
		port = 9527
	}
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	return fmt.Sprintf("http://%s:%d", host, port)
}

func firstLANIPv4() string {
	interfaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok || ipNet.IP.To4() == nil || ipNet.IP.IsLoopback() {
				continue
			}
			return ipNet.IP.String()
		}
	}
	return ""
}

func normalizeQREndpoint(value string) (string, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(value), "/")
	if trimmed == "" {
		return "", errors.New("Management Key QR 缺少 Server URL")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", errors.New("Management Key QR 的 Server URL 无效")
	}
	if parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" {
		return "", errors.New("Server URL 不能包含凭据、查询参数或片段")
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}
