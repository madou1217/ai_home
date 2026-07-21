use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use rand::{distributions::Alphanumeric, Rng};
use serde::Serialize;
use tauri::http::{method::Method, Request, Response, ResponseBuilder};

use crate::{
    error::{NativeError, NativeResult},
    server_http::BlobDownload,
};

const DEFAULT_MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024;
const DEFAULT_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBlobResponse {
    pub blob_id: String,
    pub content_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_disposition: Option<String>,
    pub size: usize,
}

#[derive(Clone)]
pub struct BlobStore {
    inner: Arc<Mutex<BlobState>>,
    max_total_bytes: usize,
    ttl: Duration,
}

struct BlobState {
    entries: HashMap<String, BlobRecord>,
    total_bytes: usize,
}

struct BlobRecord {
    content_type: String,
    content_disposition: Option<String>,
    bytes: Vec<u8>,
    last_accessed: Instant,
}

impl Default for BlobStore {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_TOTAL_BYTES, DEFAULT_TTL)
    }
}

impl BlobStore {
    fn new(max_total_bytes: usize, ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(BlobState {
                entries: HashMap::new(),
                total_bytes: 0,
            })),
            max_total_bytes,
            ttl,
        }
    }

    pub fn insert(&self, download: BlobDownload) -> NativeResult<DesktopBlobResponse> {
        let size = download.bytes.len();
        if size > self.max_total_bytes {
            return Err(NativeError::new(
                "response_too_large",
                "Blob 超过原生客户端安全限制。",
                false,
            ));
        }
        let blob_id = generate_blob_id();
        let now = Instant::now();
        let mut state = self.inner.lock().map_err(|_| NativeError::internal())?;
        purge_expired(&mut state, now, self.ttl);
        while state.total_bytes.saturating_add(size) > self.max_total_bytes {
            let Some(oldest_id) = state
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_accessed)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            remove_entry(&mut state, &oldest_id);
        }
        let response = DesktopBlobResponse {
            blob_id: blob_id.clone(),
            content_type: download.content_type.clone(),
            content_disposition: download.content_disposition.clone(),
            size,
        };
        state.total_bytes = state.total_bytes.saturating_add(size);
        state.entries.insert(
            blob_id,
            BlobRecord {
                content_type: download.content_type,
                content_disposition: download.content_disposition,
                bytes: download.bytes,
                last_accessed: now,
            },
        );
        Ok(response)
    }

    pub fn release(&self, blob_id: &str) -> NativeResult<bool> {
        validate_blob_id(blob_id)?;
        let mut state = self.inner.lock().map_err(|_| NativeError::internal())?;
        purge_expired(&mut state, Instant::now(), self.ttl);
        Ok(remove_entry(&mut state, blob_id))
    }

    pub fn protocol_response(
        &self,
        request: &Request,
    ) -> Result<Response, Box<dyn std::error::Error>> {
        if request.method() != Method::GET {
            return ResponseBuilder::new()
                .status(405)
                .mimetype("text/plain")
                .header("access-control-allow-origin", "*")
                .header("x-content-type-options", "nosniff")
                .body(b"method not allowed".to_vec());
        }
        let blob_id = request
            .uri()
            .split('?')
            .next()
            .unwrap_or("")
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("");
        if validate_blob_id(blob_id).is_err() {
            return not_found_response();
        }

        let record = {
            let mut state = self.inner.lock().map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::Other, "blob store unavailable")
            })?;
            purge_expired(&mut state, Instant::now(), self.ttl);
            state.entries.get_mut(blob_id).map(|entry| {
                entry.last_accessed = Instant::now();
                (
                    entry.content_type.clone(),
                    entry.content_disposition.clone(),
                    entry.bytes.clone(),
                )
            })
        };
        let Some((content_type, content_disposition, bytes)) = record else {
            return not_found_response();
        };
        let mut builder = ResponseBuilder::new()
            .status(200)
            .mimetype(&content_type)
            .header("content-type", content_type)
            .header("access-control-allow-origin", "*")
            .header("cache-control", "no-store")
            .header("x-content-type-options", "nosniff");
        if let Some(disposition) = content_disposition {
            builder = builder.header("content-disposition", disposition);
        }
        builder.body(bytes)
    }
}

fn not_found_response() -> Result<Response, Box<dyn std::error::Error>> {
    ResponseBuilder::new()
        .status(404)
        .mimetype("text/plain")
        .header("access-control-allow-origin", "*")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .body(b"blob not found".to_vec())
}

fn purge_expired(state: &mut BlobState, now: Instant, ttl: Duration) {
    let expired: Vec<String> = state
        .entries
        .iter()
        .filter(|(_, entry)| now.saturating_duration_since(entry.last_accessed) >= ttl)
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        remove_entry(state, &id);
    }
}

fn remove_entry(state: &mut BlobState, blob_id: &str) -> bool {
    if let Some(entry) = state.entries.remove(blob_id) {
        state.total_bytes = state.total_bytes.saturating_sub(entry.bytes.len());
        true
    } else {
        false
    }
}

fn generate_blob_id() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect::<String>()
        .to_ascii_lowercase()
}

fn validate_blob_id(value: &str) -> NativeResult<()> {
    if value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err(NativeError::invalid_input("blobId 无效。"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::http::{header::HeaderMap, RequestParts};

    fn download(value: &[u8]) -> BlobDownload {
        BlobDownload {
            status: 200,
            content_type: "image/png".to_string(),
            content_disposition: None,
            bytes: value.to_vec(),
        }
    }

    #[test]
    fn blob_store_enforces_lru_limit_and_release() {
        let store = BlobStore::new(6, Duration::from_secs(60));
        let first = store.insert(download(b"1234")).unwrap();
        let second = store.insert(download(b"5678")).unwrap();
        assert!(!store.release(&first.blob_id).unwrap());
        assert!(store.release(&second.blob_id).unwrap());
        assert!(!store.release(&second.blob_id).unwrap());
    }

    #[test]
    fn blob_store_rejects_oversized_entries_and_invalid_ids() {
        let store = BlobStore::new(3, Duration::from_secs(60));
        assert_eq!(
            store.insert(download(b"1234")).unwrap_err().code,
            "response_too_large"
        );
        assert!(store.release("../secret").is_err());
    }

    #[test]
    fn blob_store_purges_expired_entries() {
        let store = BlobStore::new(16, Duration::ZERO);
        let blob = store.insert(download(b"1234")).unwrap();
        assert!(!store.release(&blob.blob_id).unwrap());
    }

    #[test]
    fn custom_protocol_serves_blob_with_cors_and_no_store_headers() {
        let store = BlobStore::new(16, Duration::from_secs(60));
        let blob = store.insert(download(b"1234")).unwrap();
        let request = Request::new_internal(
            RequestParts {
                method: Method::GET,
                uri: format!("aihblob://localhost/{}", blob.blob_id),
                headers: HeaderMap::default(),
            },
            Vec::new(),
        );
        let response = store.protocol_response(&request).unwrap();
        assert_eq!(response.status().as_u16(), 200);
        assert_eq!(response.body(), b"1234");
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap()
                .to_str()
                .unwrap(),
            "*"
        );
    }
}
