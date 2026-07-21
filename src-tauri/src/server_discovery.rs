use std::{
    collections::{BTreeMap, BTreeSet},
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::{
    error::{NativeError, NativeResult},
    server_id::is_canonical_server_id,
};

const AIH_MDNS_SERVICE: &str = "_aih-server._tcp.local";
const MDNS_ENDPOINT: &str = "224.0.0.251:5353";
const DNS_TYPE_A: u16 = 1;
const DNS_TYPE_PTR: u16 = 12;
const DNS_TYPE_TXT: u16 = 16;
const DNS_TYPE_SRV: u16 = 33;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDiscoveryInput {
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDiscoveryResponse {
    pub ok: bool,
    pub servers: Vec<DiscoveredServer>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServerRoute {
    pub kind: String,
    pub endpoint: String,
    pub health: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredServer {
    pub stable_server_id: String,
    pub name: String,
    pub online: bool,
    pub capabilities: Vec<String>,
    pub routes: Vec<DiscoveredServerRoute>,
}

#[derive(Debug)]
struct DnsRecord {
    name: String,
    record_type: u16,
    data: DnsRecordData,
}

#[derive(Debug)]
enum DnsRecordData {
    Address(Ipv4Addr),
    Pointer(String),
    Service { port: u16, target: String },
    Text(Vec<String>),
    Other,
}

fn normalize_dns_name(value: &str) -> String {
    value.trim().trim_matches('.').to_ascii_lowercase()
}

fn encode_dns_name(value: &str, output: &mut Vec<u8>) {
    for label in value.split('.').filter(|label| !label.is_empty()) {
        output.push(label.len() as u8);
        output.extend_from_slice(label.as_bytes());
    }
    output.push(0);
}

fn build_discovery_query() -> Vec<u8> {
    let mut packet = vec![0; 12];
    packet[5] = 1;
    encode_dns_name(AIH_MDNS_SERVICE, &mut packet);
    packet.extend_from_slice(&DNS_TYPE_PTR.to_be_bytes());
    // Ask mDNS responders for a unicast response to this ephemeral client socket.
    packet.extend_from_slice(&0x8001_u16.to_be_bytes());
    packet
}

fn read_u16(packet: &[u8], offset: usize) -> Result<u16, &'static str> {
    let bytes = packet.get(offset..offset + 2).ok_or("truncated_dns_u16")?;
    Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn read_u32(packet: &[u8], offset: usize) -> Result<u32, &'static str> {
    let bytes = packet.get(offset..offset + 4).ok_or("truncated_dns_u32")?;
    Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn decode_dns_name(packet: &[u8], start: usize) -> Result<(String, usize), &'static str> {
    let mut labels = Vec::new();
    let mut offset = start;
    let mut next_offset = start;
    let mut jumped = false;
    let mut jumps = 0;
    loop {
        let length = *packet.get(offset).ok_or("truncated_dns_name")?;
        if length & 0xc0 == 0xc0 {
            let second = *packet.get(offset + 1).ok_or("truncated_dns_pointer")?;
            let pointer = (((length & 0x3f) as usize) << 8) | second as usize;
            if pointer >= packet.len() || jumps >= 32 {
                return Err("invalid_dns_pointer");
            }
            if !jumped {
                next_offset = offset + 2;
            }
            jumped = true;
            jumps += 1;
            offset = pointer;
            continue;
        }
        if length & 0xc0 != 0 {
            return Err("invalid_dns_label");
        }
        offset += 1;
        if length == 0 {
            if !jumped {
                next_offset = offset;
            }
            break;
        }
        let end = offset + length as usize;
        let label = packet.get(offset..end).ok_or("truncated_dns_label")?;
        labels.push(String::from_utf8_lossy(label).into_owned());
        offset = end;
        if !jumped {
            next_offset = offset;
        }
    }
    Ok((labels.join("."), next_offset))
}

fn decode_txt(data: &[u8]) -> Result<Vec<String>, &'static str> {
    let mut values = Vec::new();
    let mut offset = 0;
    while offset < data.len() {
        let length = data[offset] as usize;
        offset += 1;
        let end = offset + length;
        let value = data.get(offset..end).ok_or("truncated_dns_txt")?;
        values.push(String::from_utf8_lossy(value).into_owned());
        offset = end;
    }
    Ok(values)
}

fn decode_record(packet: &[u8], start: usize) -> Result<(DnsRecord, usize), &'static str> {
    let (name, name_end) = decode_dns_name(packet, start)?;
    let record_type = read_u16(packet, name_end)?;
    let _class_code = read_u16(packet, name_end + 2)?;
    let _ttl = read_u32(packet, name_end + 4)?;
    let data_length = read_u16(packet, name_end + 8)? as usize;
    let data_offset = name_end + 10;
    let data_end = data_offset + data_length;
    let raw_data = packet
        .get(data_offset..data_end)
        .ok_or("truncated_dns_record")?;
    let data = match record_type {
        DNS_TYPE_A if raw_data.len() == 4 => DnsRecordData::Address(Ipv4Addr::new(
            raw_data[0],
            raw_data[1],
            raw_data[2],
            raw_data[3],
        )),
        DNS_TYPE_PTR => {
            let (target, _) = decode_dns_name(packet, data_offset)?;
            DnsRecordData::Pointer(target)
        }
        DNS_TYPE_TXT => DnsRecordData::Text(decode_txt(raw_data)?),
        DNS_TYPE_SRV if raw_data.len() >= 7 => {
            let port = read_u16(packet, data_offset + 4)?;
            let (target, _) = decode_dns_name(packet, data_offset + 6)?;
            DnsRecordData::Service { port, target }
        }
        _ => DnsRecordData::Other,
    };
    Ok((
        DnsRecord {
            name,
            record_type,
            data,
        },
        data_end,
    ))
}

fn decode_records(packet: &[u8]) -> Result<Vec<DnsRecord>, &'static str> {
    if packet.len() < 12 {
        return Err("truncated_dns_header");
    }
    let question_count = read_u16(packet, 4)? as usize;
    let record_count = read_u16(packet, 6)? as usize
        + read_u16(packet, 8)? as usize
        + read_u16(packet, 10)? as usize;
    let mut offset = 12;
    for _ in 0..question_count {
        let (_, name_end) = decode_dns_name(packet, offset)?;
        offset = name_end + 4;
        if offset > packet.len() {
            return Err("truncated_dns_question");
        }
    }
    let mut records = Vec::new();
    for _ in 0..record_count {
        let (record, next) = decode_record(packet, offset)?;
        records.push(record);
        offset = next;
    }
    Ok(records)
}

fn txt_map(values: &[String]) -> BTreeMap<String, String> {
    values
        .iter()
        .filter_map(|value| value.split_once('='))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect()
}

fn normalize_server_id(value: &str) -> String {
    if is_canonical_server_id(value) {
        value.to_string()
    } else {
        String::new()
    }
}

fn normalize_capabilities(value: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for capability in value.split(',') {
        let capability = capability.trim().to_ascii_lowercase();
        if !capability.is_empty()
            && capability.len() <= 48
            && capability.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'-' | b'_' | b'.')
            })
            && seen.insert(capability.clone())
        {
            normalized.push(capability);
        }
    }
    normalized
}

fn parse_discovery_response(
    packet: &[u8],
    sender: SocketAddr,
) -> Result<Vec<DiscoveredServer>, &'static str> {
    let records = decode_records(packet)?;
    let service_name = normalize_dns_name(AIH_MDNS_SERVICE);
    let mut instances = BTreeSet::new();
    for record in &records {
        let record_name = normalize_dns_name(&record.name);
        if record.record_type == DNS_TYPE_PTR && record_name == service_name {
            if let DnsRecordData::Pointer(instance) = &record.data {
                instances.insert(normalize_dns_name(instance));
            }
        } else if matches!(record.record_type, DNS_TYPE_SRV | DNS_TYPE_TXT)
            && record_name.ends_with(&format!(".{service_name}"))
        {
            instances.insert(record_name);
        }
    }

    let mut discovered = Vec::new();
    for instance in instances {
        let text = records.iter().find_map(|record| {
            if normalize_dns_name(&record.name) != instance {
                return None;
            }
            match &record.data {
                DnsRecordData::Text(values) => Some(txt_map(values)),
                _ => None,
            }
        });
        let Some(text) = text else { continue };
        let server_id = normalize_server_id(text.get("id").map(String::as_str).unwrap_or(""));
        if server_id.is_empty() {
            continue;
        }
        let service = records.iter().find_map(|record| {
            if normalize_dns_name(&record.name) != instance {
                return None;
            }
            match &record.data {
                DnsRecordData::Service { port, target } if *port > 0 => {
                    Some((*port, normalize_dns_name(target)))
                }
                _ => None,
            }
        });
        let Some((port, target)) = service else {
            continue;
        };
        let mut addresses: Vec<IpAddr> = records
            .iter()
            .filter_map(|record| {
                if normalize_dns_name(&record.name) != target {
                    return None;
                }
                match record.data {
                    DnsRecordData::Address(address) => Some(IpAddr::V4(address)),
                    _ => None,
                }
            })
            .collect();
        if addresses.is_empty() {
            addresses.push(sender.ip());
        }
        addresses.sort();
        addresses.dedup();
        let routes = addresses
            .into_iter()
            .map(|address| DiscoveredServerRoute {
                kind: "direct-lan".to_string(),
                endpoint: format!("http://{address}:{port}"),
                health: "healthy".to_string(),
            })
            .collect();
        let name = text
            .get("name")
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .unwrap_or(&server_id)
            .chars()
            .take(120)
            .collect();
        discovered.push(DiscoveredServer {
            stable_server_id: server_id,
            name,
            online: true,
            capabilities: normalize_capabilities(
                text.get("capabilities").map(String::as_str).unwrap_or(""),
            ),
            routes,
        });
    }
    Ok(merge_discovered_servers(discovered))
}

fn merge_discovered_servers(servers: Vec<DiscoveredServer>) -> Vec<DiscoveredServer> {
    let mut merged: BTreeMap<String, DiscoveredServer> = BTreeMap::new();
    for server in servers {
        if let Some(existing) = merged.get_mut(&server.stable_server_id) {
            for route in server.routes {
                if !existing
                    .routes
                    .iter()
                    .any(|current| current.endpoint == route.endpoint)
                {
                    existing.routes.push(route);
                }
            }
            let mut capabilities: BTreeSet<String> =
                existing.capabilities.iter().cloned().collect();
            capabilities.extend(server.capabilities);
            existing.capabilities = capabilities.into_iter().collect();
            existing.online |= server.online;
        } else {
            merged.insert(server.stable_server_id.clone(), server);
        }
    }
    for server in merged.values_mut() {
        server
            .routes
            .sort_by(|left, right| left.endpoint.cmp(&right.endpoint));
    }
    merged.into_values().collect()
}

fn discovery_error() -> NativeError {
    NativeError::new(
        "server_discovery_failed",
        "无法发现局域网中的 AI Home Server。",
        true,
    )
}

pub fn discovery_timeout(input: &ServerDiscoveryInput) -> Duration {
    Duration::from_millis(input.timeout_ms.unwrap_or(1_500).clamp(250, 10_000))
}

pub fn discover_servers(timeout: Duration) -> NativeResult<Vec<DiscoveredServer>> {
    let timeout = timeout.clamp(Duration::from_millis(250), Duration::from_secs(10));
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|_| discovery_error())?;
    socket
        .set_multicast_ttl_v4(255)
        .map_err(|_| discovery_error())?;
    socket
        .send_to(&build_discovery_query(), MDNS_ENDPOINT)
        .map_err(|_| discovery_error())?;
    let deadline = Instant::now() + timeout;
    let mut buffer = vec![0_u8; 65_535];
    let mut discovered = Vec::new();
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        socket
            .set_read_timeout(Some(remaining.min(Duration::from_millis(250))))
            .map_err(|_| discovery_error())?;
        match socket.recv_from(&mut buffer) {
            Ok((length, sender)) => {
                if let Ok(mut servers) = parse_discovery_response(&buffer[..length], sender) {
                    discovered.append(&mut servers);
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return Err(discovery_error()),
        }
    }
    Ok(merge_discovered_servers(discovered))
}

pub fn run_server_discovery(input: ServerDiscoveryInput) -> NativeResult<ServerDiscoveryResponse> {
    let servers = discover_servers(discovery_timeout(&input))?;
    Ok(ServerDiscoveryResponse { ok: true, servers })
}

#[cfg(test)]
mod tests {
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    use super::{
        build_discovery_query, discovery_timeout, merge_discovered_servers,
        parse_discovery_response, ServerDiscoveryInput,
    };

    fn dns_name(value: &str) -> Vec<u8> {
        let mut encoded = Vec::new();
        for label in value.split('.') {
            encoded.push(label.len() as u8);
            encoded.extend_from_slice(label.as_bytes());
        }
        encoded.push(0);
        encoded
    }

    fn record(name: &str, record_type: u16, class_code: u16, ttl: u32, data: Vec<u8>) -> Vec<u8> {
        let mut encoded = dns_name(name);
        encoded.extend_from_slice(&record_type.to_be_bytes());
        encoded.extend_from_slice(&class_code.to_be_bytes());
        encoded.extend_from_slice(&ttl.to_be_bytes());
        encoded.extend_from_slice(&(data.len() as u16).to_be_bytes());
        encoded.extend_from_slice(&data);
        encoded
    }

    fn txt(values: &[&str]) -> Vec<u8> {
        let mut encoded = Vec::new();
        for value in values {
            encoded.push(value.len() as u8);
            encoded.extend_from_slice(value.as_bytes());
        }
        encoded
    }

    fn srv(port: u16, target: &str) -> Vec<u8> {
        let mut encoded = vec![0, 0, 0, 0];
        encoded.extend_from_slice(&port.to_be_bytes());
        encoded.extend_from_slice(&dns_name(target));
        encoded
    }

    fn response_packet() -> Vec<u8> {
        let service = "_aih-server._tcp.local";
        let instance = "Home._aih-server._tcp.local";
        let target = "server-stable-home.local";
        let records = vec![
            record(service, 12, 1, 120, dns_name(instance)),
            record(instance, 33, 0x8001, 120, srv(9527, target)),
            record(
                instance,
                16,
                0x8001,
                120,
                txt(&[
                    "id=server-stable-home",
                    "name=Home Server",
                    "version=1",
                    "capabilities=client-api,stream,blob",
                ]),
            ),
            record(target, 1, 0x8001, 120, vec![192, 168, 1, 20]),
        ];
        let mut packet = vec![0, 0, 0x84, 0, 0, 0];
        packet.extend_from_slice(&(records.len() as u16).to_be_bytes());
        packet.extend_from_slice(&[0, 0, 0, 0]);
        for item in records {
            packet.extend_from_slice(&item);
        }
        packet
    }

    #[test]
    fn query_requests_only_the_ai_home_server_service() {
        let query = build_discovery_query();
        assert!(query.windows(11).any(|part| part == b"_aih-server"));
        assert!(!query.windows(13).any(|part| part == b"managementKey"));
    }

    #[test]
    fn response_becomes_one_direct_lan_route_without_credentials() {
        let sender = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 88)), 5353);
        let servers = parse_discovery_response(&response_packet(), sender).expect("parse response");

        assert_eq!(servers.len(), 1);
        let server = &servers[0];
        assert_eq!(server.stable_server_id, "server-stable-home");
        assert_eq!(server.name, "Home Server");
        assert_eq!(server.capabilities, vec!["client-api", "stream", "blob"]);
        assert_eq!(server.routes.len(), 1);
        assert_eq!(server.routes[0].kind, "direct-lan");
        assert_eq!(server.routes[0].endpoint, "http://192.168.1.20:9527");
        assert!(!serde_json::to_string(server)
            .expect("serialize discovery")
            .contains("managementKey"));
    }

    #[test]
    fn duplicate_interface_responses_merge_routes_by_stable_server_id() {
        let sender = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 88)), 5353);
        let first = parse_discovery_response(&response_packet(), sender).expect("first response");
        let second = parse_discovery_response(&response_packet(), sender).expect("second response");
        let merged = merge_discovered_servers(first.into_iter().chain(second).collect());

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].routes.len(), 1);
    }

    #[test]
    fn desktop_timeout_uses_the_same_bounded_contract_as_the_renderer() {
        assert_eq!(
            discovery_timeout(&ServerDiscoveryInput { timeout_ms: None }).as_millis(),
            1_500
        );
        assert_eq!(
            discovery_timeout(&ServerDiscoveryInput {
                timeout_ms: Some(1),
            })
            .as_millis(),
            250
        );
        assert_eq!(
            discovery_timeout(&ServerDiscoveryInput {
                timeout_ms: Some(20_000),
            })
            .as_millis(),
            10_000
        );
    }
}
