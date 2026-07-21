use std::{
    collections::BTreeSet,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::{future::join_all, StreamExt};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use reqwest::{header::ACCEPT, Client, Response};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    endpoint::{build_request_url, normalize_trusted_endpoint},
    error::{NativeError, NativeResult},
    secret_store::TrustedRouteEnvelope,
    server_discovery::DiscoveredServer,
    server_id::is_canonical_server_id,
};

const ROUTE_PROOF_PATH: &str = "/v0/fabric/route-proof";
const ROUTE_PROOF_VERSION: u8 = 1;
const MAX_PROOF_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_PROOF_ROUTES: usize = 16;
const MAX_PROOF_LIFETIME_MS: u64 = 180_000;
const PROOF_CLOCK_SKEW_MS: u64 = 30_000;
const PROOF_REQUEST_TIMEOUT_MS: u64 = 2_000;
const MIN_MANAGEMENT_KEY_LENGTH: usize = 32;
const MAX_MANAGEMENT_KEY_LENGTH: usize = 8_192;

type HmacSha256 = Hmac<Sha256>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RouteProofRequest<'a> {
    version: u8,
    nonce: &'a str,
}

#[derive(Deserialize)]
struct RouteProofResponse {
    ok: bool,
    result: Option<RouteProof>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RouteProof {
    version: u8,
    server_id: String,
    nonce: String,
    issued_at: u64,
    expires_at: u64,
    endpoints: Vec<String>,
    proof: String,
}

fn proof_error(code: &str, retriable: bool) -> NativeError {
    NativeError::new(code, "局域网 Server 身份验证失败。", retriable)
}

fn now_ms() -> NativeResult<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .map_err(|_| NativeError::internal())
}

fn random_nonce() -> String {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn validate_management_key(value: &str) -> NativeResult<&str> {
    let value = value.trim();
    if value.len() < MIN_MANAGEMENT_KEY_LENGTH
        || value.len() > MAX_MANAGEMENT_KEY_LENGTH
        || value.contains(['\r', '\n', '\0'])
    {
        return Err(proof_error("lan_route_management_key_weak", false));
    }
    Ok(value)
}

fn canonical_payload(proof: &RouteProof) -> String {
    let mut payload = format!(
        "AIH-LAN-ROUTE-PROOF/1\nnonce={}\nserver={}\nissued={}\nexpires={}\nroutes={}",
        proof.nonce,
        proof.server_id,
        proof.issued_at,
        proof.expires_at,
        proof.endpoints.len()
    );
    for endpoint in &proof.endpoints {
        payload.push('\n');
        payload.push_str(endpoint);
    }
    payload
}

fn verify_proof(
    proof: &RouteProof,
    expected_server_id: &str,
    expected_nonce: &str,
    candidate_endpoint: &str,
    management_key: &str,
    current_time_ms: u64,
) -> NativeResult<()> {
    if proof.version != ROUTE_PROOF_VERSION
        || proof.server_id != expected_server_id
        || proof.nonce != expected_nonce
        || !is_canonical_server_id(&proof.server_id)
        || proof.endpoints.is_empty()
        || proof.endpoints.len() > MAX_PROOF_ROUTES
    {
        return Err(proof_error("lan_route_proof_mismatch", false));
    }
    if proof.issued_at > current_time_ms.saturating_add(PROOF_CLOCK_SKEW_MS)
        || proof.expires_at <= current_time_ms
        || proof.expires_at <= proof.issued_at
        || proof.expires_at.saturating_sub(proof.issued_at) > MAX_PROOF_LIFETIME_MS
        || current_time_ms.saturating_sub(PROOF_CLOCK_SKEW_MS) > proof.expires_at
    {
        return Err(proof_error("lan_route_proof_expired", true));
    }

    let normalized = proof
        .endpoints
        .iter()
        .map(|endpoint| {
            let value = normalize_trusted_endpoint(endpoint)?;
            if value != *endpoint {
                return Err(proof_error("lan_route_proof_endpoint_invalid", false));
            }
            Ok(value)
        })
        .collect::<NativeResult<Vec<_>>>()?;
    let ordered = normalized.iter().cloned().collect::<BTreeSet<_>>();
    if ordered.len() != normalized.len()
        || ordered.iter().cloned().collect::<Vec<_>>() != normalized
        || !ordered.contains(candidate_endpoint)
    {
        return Err(proof_error("lan_route_proof_endpoint_mismatch", false));
    }

    let signature = URL_SAFE_NO_PAD
        .decode(proof.proof.as_bytes())
        .map_err(|_| proof_error("lan_route_proof_invalid", false))?;
    let mut mac = HmacSha256::new_from_slice(management_key.as_bytes())
        .map_err(|_| proof_error("lan_route_proof_invalid", false))?;
    mac.update(canonical_payload(proof).as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| proof_error("lan_route_proof_invalid", false))
}

async fn read_limited(response: Response) -> NativeResult<Vec<u8>> {
    if response
        .content_length()
        .map(|length| length > MAX_PROOF_RESPONSE_BYTES as u64)
        .unwrap_or(false)
    {
        return Err(proof_error("lan_route_proof_too_large", false));
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| proof_error("lan_route_proof_unavailable", true))?;
        if body.len().saturating_add(chunk.len()) > MAX_PROOF_RESPONSE_BYTES {
            return Err(proof_error("lan_route_proof_too_large", false));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn request_route_proof(
    client: &Client,
    candidate_endpoint: &str,
    expected_server_id: &str,
    management_key: &str,
) -> NativeResult<TrustedRouteEnvelope> {
    let management_key = validate_management_key(management_key)?;
    let candidate_endpoint = normalize_trusted_endpoint(candidate_endpoint)?;
    let nonce = random_nonce();
    let url = build_request_url(&candidate_endpoint, ROUTE_PROOF_PATH)?;
    let started_at = Instant::now();
    // Intentionally no Authorization header: an untrusted mDNS endpoint must
    // never receive the Management Key before its proof has been verified.
    let response = client
        .post(url)
        .header(ACCEPT, "application/json")
        .json(&RouteProofRequest {
            version: ROUTE_PROOF_VERSION,
            nonce: &nonce,
        })
        .timeout(Duration::from_millis(PROOF_REQUEST_TIMEOUT_MS))
        .send()
        .await
        .map_err(|_| proof_error("lan_route_proof_unavailable", true))?;
    if !response.status().is_success() {
        return Err(
            proof_error("lan_route_proof_http_error", true).with_status(response.status().as_u16())
        );
    }
    let payload = serde_json::from_slice::<RouteProofResponse>(&read_limited(response).await?)
        .map_err(|_| proof_error("lan_route_proof_invalid", false))?;
    let proof = payload
        .result
        .filter(|_| payload.ok)
        .ok_or_else(|| proof_error("lan_route_proof_invalid", false))?;
    verify_proof(
        &proof,
        expected_server_id,
        &nonce,
        &candidate_endpoint,
        management_key,
        now_ms()?,
    )?;
    let digest = Sha256::digest(format!("{expected_server_id}\0{candidate_endpoint}").as_bytes());
    Ok(TrustedRouteEnvelope {
        id: format!("lan-{}", hex_prefix(&digest, 12)),
        kind: "direct-lan".to_string(),
        endpoint: candidate_endpoint,
        via_profile_id: String::new(),
        health: "healthy".to_string(),
        rtt_ms: started_at.elapsed().as_secs_f64() * 1_000.0,
        expires_at: proof.expires_at,
    })
}

fn hex_prefix(bytes: &[u8], length: usize) -> String {
    bytes
        .iter()
        .flat_map(|byte| format!("{byte:02x}").chars().collect::<Vec<_>>())
        .take(length)
        .collect()
}

pub async fn verify_discovered_lan_routes(
    client: &Client,
    profile_id: &str,
    expected_server_id: &str,
    management_key: &str,
    discovered: &[DiscoveredServer],
) -> NativeResult<Vec<TrustedRouteEnvelope>> {
    if !is_canonical_server_id(expected_server_id) {
        return Err(proof_error("lan_route_server_id_invalid", false));
    }
    validate_management_key(management_key)?;
    let server = discovered
        .iter()
        .find(|server| server.stable_server_id == expected_server_id)
        .ok_or_else(|| proof_error("lan_route_server_not_found", true))?;
    let attempts = server
        .routes
        .iter()
        .filter(|candidate| candidate.kind == "direct-lan")
        .take(MAX_PROOF_ROUTES)
        .map(|candidate| {
            request_route_proof(
                client,
                &candidate.endpoint,
                expected_server_id,
                management_key,
            )
        });
    let mut routes = join_all(attempts)
        .await
        .into_iter()
        .filter_map(Result::ok)
        .map(|mut route| {
            route.via_profile_id = profile_id.to_string();
            route
        })
        .collect::<Vec<_>>();
    routes.sort_by(|left, right| left.endpoint.cmp(&right.endpoint));
    routes.dedup_by(|left, right| left.endpoint == right.endpoint);
    if routes.is_empty() {
        return Err(proof_error("lan_route_proof_failed", true));
    }
    Ok(routes)
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    use super::*;

    fn signed_proof(
        key: &str,
        nonce: &str,
        server_id: &str,
        endpoints: Vec<String>,
        issued_at: u64,
    ) -> RouteProof {
        let mut proof = RouteProof {
            version: 1,
            server_id: server_id.to_string(),
            nonce: nonce.to_string(),
            issued_at,
            expires_at: issued_at + 120_000,
            endpoints,
            proof: String::new(),
        };
        let mut mac = HmacSha256::new_from_slice(key.as_bytes()).unwrap();
        mac.update(canonical_payload(&proof).as_bytes());
        proof.proof = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        proof
    }

    #[test]
    fn proof_binds_nonce_server_and_candidate_endpoint() {
        let key = "m".repeat(32);
        let now = 1_700_000_000_000;
        let proof = signed_proof(
            &key,
            "nonce",
            "server-home",
            vec!["http://192.168.1.20:9527".to_string()],
            now,
        );
        verify_proof(
            &proof,
            "server-home",
            "nonce",
            "http://192.168.1.20:9527",
            &key,
            now + 1,
        )
        .unwrap();
        assert!(verify_proof(
            &proof,
            "server-home",
            "replayed",
            "http://192.168.1.20:9527",
            &key,
            now + 1,
        )
        .is_err());
        assert!(verify_proof(
            &proof,
            "server-other",
            "nonce",
            "http://192.168.1.20:9527",
            &key,
            now + 1,
        )
        .is_err());
        assert!(verify_proof(
            &proof,
            "server-home",
            "nonce",
            "http://192.168.1.99:9527",
            &key,
            now + 1,
        )
        .is_err());
    }

    #[test]
    fn proof_rejects_tampering_expiry_and_public_http_routes() {
        let key = "m".repeat(32);
        let now = 1_700_000_000_000;
        let mut proof = signed_proof(
            &key,
            "nonce",
            "server-home",
            vec!["http://192.168.1.20:9527".to_string()],
            now,
        );
        proof.endpoints[0] = "http://192.168.1.21:9527".to_string();
        assert!(verify_proof(
            &proof,
            "server-home",
            "nonce",
            "http://192.168.1.21:9527",
            &key,
            now + 1,
        )
        .is_err());

        let expired = signed_proof(
            &key,
            "nonce",
            "server-home",
            vec!["http://192.168.1.20:9527".to_string()],
            now - 200_000,
        );
        assert!(verify_proof(
            &expired,
            "server-home",
            "nonce",
            "http://192.168.1.20:9527",
            &key,
            now,
        )
        .is_err());

        let public = signed_proof(
            &key,
            "nonce",
            "server-home",
            vec!["http://203.0.113.8:9527".to_string()],
            now,
        );
        assert!(verify_proof(
            &public,
            "server-home",
            "nonce",
            "http://203.0.113.8:9527",
            &key,
            now + 1,
        )
        .is_err());
    }

    #[test]
    fn proof_request_sends_neither_authorization_nor_management_key() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let endpoint = format!("http://{address}");
        let response_endpoint = endpoint.clone();
        let key = "m".repeat(32);
        let signing_key = key.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let read = socket.read(&mut buffer).unwrap();
                request.extend_from_slice(&buffer[..read]);
                let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(str::trim)
                            .map(str::to_string)
                    })
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
            let request_text = String::from_utf8(request).unwrap();
            let body = request_text.split("\r\n\r\n").nth(1).unwrap_or("");
            let payload: serde_json::Value = serde_json::from_str(body).unwrap();
            let nonce = payload
                .get("nonce")
                .and_then(serde_json::Value::as_str)
                .unwrap();
            let proof = signed_proof(
                &signing_key,
                nonce,
                "server-home",
                vec![response_endpoint],
                now_ms().unwrap().saturating_sub(100),
            );
            let response = serde_json::to_vec(&serde_json::json!({
                "ok": true,
                "result": proof
            }))
            .unwrap();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                response.len()
            )
            .unwrap();
            socket.write_all(&response).unwrap();
            request_text
        });

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let route = tauri::async_runtime::block_on(request_route_proof(
            &client,
            &endpoint,
            "server-home",
            &key,
        ))
        .unwrap();
        let request = server.join().unwrap();
        assert_eq!(route.endpoint, endpoint);
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
        assert!(!request.contains(&key));
    }
}
