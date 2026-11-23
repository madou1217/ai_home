package tuningress

import (
	"encoding/json"
	"fmt"
)

const (
	inboundTUNTag      = "tun-in"
	outboundIngressTag = "ingress-http"
	outboundDirectTag  = "direct"
	dnsDirectTag       = "dns-direct"
	logLevel           = "warn"
	dnsStrategy        = "prefer_ipv4"
)

// Render validates options and returns a sing-box JSON configuration that
// accepts operating-system traffic on a TUN interface and forwards it to the
// local HTTP proxy ingress. Render is pure: it starts no process and changes no
// route.
//
// The result contains the local proxy credentials, so callers must treat it as
// a secret and must not log it.
func Render(options Options) ([]byte, error) {
	normalized, err := options.settings()
	if err != nil {
		return nil, err
	}
	return render(normalized)
}

func render(options *settings) ([]byte, error) {
	config := singBoxConfig{
		Log: logConfig{
			Level:     logLevel,
			Timestamp: true,
			Output:    options.logFile,
		},
		DNS: dnsConfig{
			Servers: []dnsServer{{
				Type:   "udp",
				Tag:    dnsDirectTag,
				Server: options.directDNSServer,
				Detour: outboundDirectTag,
			}},
			Final:    dnsDirectTag,
			Strategy: dnsStrategy,
		},
		Inbounds: []tunInbound{{
			Type:          "tun",
			Tag:           inboundTUNTag,
			InterfaceName: options.interfaceName,
			Address:       append([]string(nil), options.addresses...),
			MTU:           options.mtu,
			AutoRoute:     options.autoRoute,
			StrictRoute:   options.strictRoute,
			Stack:         options.stack,
		}},
		Outbounds: []outbound{{
			Type:       "http",
			Tag:        outboundIngressTag,
			Server:     options.upstreamHost,
			ServerPort: options.upstreamPort,
			Username:   options.upstreamUser,
			Password:   options.upstreamPass,
		}, {
			Type: "direct",
			Tag:  outboundDirectTag,
		}},
		Route: routeConfig{
			// sniff enables protocol detection so DNS can be intercepted before
			// it reaches the HTTP outbound. An HTTP proxy cannot carry UDP.
			Rules: []routeRule{
				{Action: "sniff"},
				{Protocol: "dns", Action: "hijack-dns"},
			},
			Final:                 outboundIngressTag,
			AutoDetectInterface:   true,
			DefaultDomainResolver: dnsDirectTag,
		},
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		// Plain structs cannot fail to marshal; keep the typed error anyway.
		return nil, fmt.Errorf("%w: encode sing-box config: %v", ErrInvalidOptions, err)
	}
	return append(data, '\n'), nil
}

type singBoxConfig struct {
	Log       logConfig    `json:"log"`
	DNS       dnsConfig    `json:"dns"`
	Inbounds  []tunInbound `json:"inbounds"`
	Outbounds []outbound   `json:"outbounds"`
	Route     routeConfig  `json:"route"`
}

type logConfig struct {
	Level     string `json:"level"`
	Timestamp bool   `json:"timestamp"`
	Output    string `json:"output,omitempty"`
}

type dnsConfig struct {
	Servers  []dnsServer `json:"servers"`
	Final    string      `json:"final"`
	Strategy string      `json:"strategy"`
}

type dnsServer struct {
	Type   string `json:"type"`
	Tag    string `json:"tag"`
	Server string `json:"server"`
	Detour string `json:"detour"`
}

type tunInbound struct {
	Type          string   `json:"type"`
	Tag           string   `json:"tag"`
	InterfaceName string   `json:"interface_name,omitempty"`
	Address       []string `json:"address"`
	MTU           int      `json:"mtu"`
	AutoRoute     bool     `json:"auto_route"`
	StrictRoute   bool     `json:"strict_route"`
	Stack         string   `json:"stack"`
}

type outbound struct {
	Type       string `json:"type"`
	Tag        string `json:"tag"`
	Server     string `json:"server,omitempty"`
	ServerPort int    `json:"server_port,omitempty"`
	Username   string `json:"username,omitempty"`
	Password   string `json:"password,omitempty"`
}

type routeConfig struct {
	Rules                 []routeRule `json:"rules"`
	Final                 string      `json:"final"`
	AutoDetectInterface   bool        `json:"auto_detect_interface"`
	DefaultDomainResolver string      `json:"default_domain_resolver"`
}

type routeRule struct {
	Protocol string `json:"protocol,omitempty"`
	Action   string `json:"action"`
}
