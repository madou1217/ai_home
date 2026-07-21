use serde::Serialize;

pub type NativeResult<T> = Result<T, NativeError>;

#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct NativeError {
    pub code: String,
    pub message: String,
    pub retriable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

impl NativeError {
    pub fn new(code: &str, message: &str, retriable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.to_string(),
            retriable,
            status: None,
        }
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    pub fn invalid_input(message: &str) -> Self {
        Self::new("invalid_input", message, false)
    }

    pub fn storage() -> Self {
        Self::new(
            "profile_storage_error",
            "无法读取或保存原生 Server Profile。",
            true,
        )
    }

    pub fn internal() -> Self {
        Self::new("native_internal_error", "原生客户端内部错误。", true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_error_contains_only_safe_fields() {
        let encoded = serde_json::to_string(&NativeError::invalid_input("请求参数无效。"))
            .expect("serialize native error");
        assert!(encoded.contains("invalid_input"));
        assert!(!encoded.contains("managementKey"));
        assert!(!encoded.contains("authorization"));
    }
}
