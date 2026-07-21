use crate::error::{NativeError, NativeResult};

pub const MAX_SERVER_ID_LENGTH: usize = 64;

pub fn is_canonical_server_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (2..=MAX_SERVER_ID_LENGTH).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..].iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        })
}

pub fn require_server_id(value: &str) -> NativeResult<String> {
    if is_canonical_server_id(value) {
        Ok(value.to_string())
    } else {
        Err(NativeError::new(
            "invalid_stable_server_id",
            "Server 稳定身份无效。",
            false,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_id_contract_is_rejecting_and_bounded_to_sixty_four_characters() {
        assert!(is_canonical_server_id("a1"));
        assert!(is_canonical_server_id(&format!("a{}", "b".repeat(63))));
        let invalid_values = vec![
            "a".to_string(),
            format!("a{}", "b".repeat(64)),
            "Server-home".to_string(),
            " server-home".to_string(),
            "-server-home".to_string(),
            "server/home".to_string(),
        ];
        for invalid in invalid_values {
            assert!(!is_canonical_server_id(&invalid), "{invalid}");
        }
    }
}
