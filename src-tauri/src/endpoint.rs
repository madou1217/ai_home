use std::net::IpAddr;

use reqwest::Url;

use crate::error::{NativeError, NativeResult};

fn is_loopback_host(host: &str) -> bool {
    let ip_candidate = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    host.eq_ignore_ascii_case("localhost")
        || ip_candidate
            .parse::<IpAddr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
}

pub fn normalize_endpoint(value: &str) -> NativeResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 {
        return Err(NativeError::invalid_input("Server URL 无效。"));
    }

    let mut url =
        Url::parse(trimmed).map_err(|_| NativeError::invalid_input("Server URL 无效。"))?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(NativeError::invalid_input(
            "Server URL 不能包含凭据、查询参数或片段。",
        ));
    }

    let host = url
        .host_str()
        .ok_or_else(|| NativeError::invalid_input("Server URL 缺少主机名。"))?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback_host(host) => {}
        "http" => {
            return Err(NativeError::new(
                "insecure_endpoint",
                "远程 Server 必须使用 HTTPS；HTTP 仅允许本机回环地址。",
                false,
            ));
        }
        _ => {
            return Err(NativeError::invalid_input(
                "Server URL 仅支持 HTTP 或 HTTPS。",
            ));
        }
    }

    let normalized_path = url.path().trim_end_matches('/').to_string();
    url.set_path(&normalized_path);
    let mut normalized = url.to_string();
    if normalized.ends_with('/') {
        normalized.pop();
    }
    Ok(normalized)
}

pub fn build_request_url(endpoint: &str, relative_path: &str) -> NativeResult<Url> {
    if relative_path.is_empty()
        || relative_path.len() > 8192
        || !relative_path.starts_with('/')
        || relative_path.starts_with("//")
        || relative_path.contains('\\')
        || relative_path.contains('#')
    {
        return Err(NativeError::invalid_input(
            "请求路径必须是 Server 下的相对 /v0 路径。",
        ));
    }

    let parsed_path = Url::parse(&format!("http://aih-native.invalid{relative_path}"))
        .map_err(|_| NativeError::invalid_input("请求路径无效。"))?;
    let pathname = parsed_path.path();
    if pathname != "/v0" && !pathname.starts_with("/v0/") {
        return Err(NativeError::invalid_input("原生请求仅允许访问 /v0 路径。"));
    }

    let normalized_endpoint = normalize_endpoint(endpoint)?;
    let mut target = Url::parse(&normalized_endpoint)
        .map_err(|_| NativeError::invalid_input("Server URL 无效。"))?;
    let base_path = target.path().trim_end_matches('/');
    target.set_path(&format!("{base_path}{pathname}"));
    target.set_query(parsed_path.query());
    target.set_fragment(None);
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_allows_https_and_loopback_http() {
        assert_eq!(
            normalize_endpoint("https://example.com/ui/").unwrap(),
            "https://example.com/ui"
        );
        assert_eq!(
            normalize_endpoint("http://127.0.0.1:9527/").unwrap(),
            "http://127.0.0.1:9527"
        );
        assert_eq!(
            normalize_endpoint("http://[::1]:9527").unwrap(),
            "http://[::1]:9527"
        );
    }

    #[test]
    fn endpoint_rejects_remote_http_and_embedded_credentials() {
        assert_eq!(
            normalize_endpoint("http://example.com").unwrap_err().code,
            "insecure_endpoint"
        );
        assert!(normalize_endpoint("https://user:pass@example.com").is_err());
        assert!(normalize_endpoint("https://example.com?access_token=x").is_err());
    }

    #[test]
    fn request_url_preserves_endpoint_prefix_and_query() {
        let url = build_request_url(
            "https://broker.example/base/proxy",
            "/v0/node-rpc/device-status?limit=10",
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://broker.example/base/proxy/v0/node-rpc/device-status?limit=10"
        );
    }

    #[test]
    fn request_url_rejects_absolute_and_escaped_paths() {
        for path in [
            "https://attacker.example/v0/test",
            "//attacker.example/v0/test",
            "/admin",
            "/v0/../admin",
            "/v0/test#fragment",
            "/v0\\test",
        ] {
            assert!(
                build_request_url("https://example.com", path).is_err(),
                "{path}"
            );
        }
    }
}
