use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteHealth {
    Healthy,
    Degraded,
    Offline,
    Unknown,
}

impl RouteHealth {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "healthy" => Self::Healthy,
            "degraded" => Self::Degraded,
            "offline" => Self::Offline,
            _ => Self::Unknown,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RouteCandidate {
    pub id: String,
    pub kind: String,
    pub endpoint: String,
    pub health: RouteHealth,
    pub rtt_ms: f64,
}

#[derive(Clone, Debug, Default)]
struct RouteObservation {
    total: u64,
    failures: u64,
    consecutive_failures: u32,
    rtt_ms: f64,
    succeeded: bool,
}

#[derive(Default)]
struct ProfileRouteState {
    selected_route_id: String,
    selected_at: Option<Instant>,
    challenger_route_id: String,
    challenger_since: Option<Instant>,
    observations: HashMap<String, RouteObservation>,
}

#[derive(Clone, Default)]
pub struct ServerRouteRuntime {
    profiles: Arc<Mutex<HashMap<String, ProfileRouteState>>>,
}

const STICKY_DURATION: Duration = Duration::from_secs(30);
const CHALLENGER_DEBOUNCE: Duration = Duration::from_millis(1_500);
const HYSTERESIS_SCORE: f64 = 8.0;

impl ServerRouteRuntime {
    pub fn order_candidates(
        &self,
        profile_id: &str,
        candidates: Vec<RouteCandidate>,
        excluded: &HashSet<String>,
    ) -> Vec<RouteCandidate> {
        let Ok(mut profiles) = self.profiles.lock() else {
            return candidates;
        };
        let state = profiles.entry(profile_id.to_string()).or_default();
        let mut scored = candidates
            .into_iter()
            .filter(|candidate| !excluded.contains(&candidate.id))
            .map(|candidate| {
                let score = score_candidate(&candidate, state.observations.get(&candidate.id));
                (candidate, score)
            })
            .filter(|(_, score)| score.is_finite())
            .collect::<Vec<_>>();
        scored.sort_by(|left, right| {
            right
                .1
                .total_cmp(&left.1)
                .then_with(|| left.0.id.cmp(&right.0.id))
        });
        if scored.len() < 2 || state.selected_route_id.is_empty() {
            return scored.into_iter().map(|(candidate, _)| candidate).collect();
        }

        let Some(current_index) = scored
            .iter()
            .position(|(candidate, _)| candidate.id == state.selected_route_id)
        else {
            return scored.into_iter().map(|(candidate, _)| candidate).collect();
        };
        if current_index == 0 {
            state.challenger_route_id.clear();
            state.challenger_since = None;
            return scored.into_iter().map(|(candidate, _)| candidate).collect();
        }

        let now = Instant::now();
        if state
            .selected_at
            .map(|selected_at| now.duration_since(selected_at) < STICKY_DURATION)
            .unwrap_or(false)
        {
            scored.swap(0, current_index);
            return scored.into_iter().map(|(candidate, _)| candidate).collect();
        }

        let current_score = scored[current_index].1;
        let challenger_id = scored[0].0.id.clone();
        if scored[0].1 - current_score < HYSTERESIS_SCORE {
            state.challenger_route_id.clear();
            state.challenger_since = None;
            scored.swap(0, current_index);
            return scored.into_iter().map(|(candidate, _)| candidate).collect();
        }
        if state.challenger_route_id != challenger_id {
            state.challenger_route_id = challenger_id;
            state.challenger_since = Some(now);
            scored.swap(0, current_index);
            return scored.into_iter().map(|(candidate, _)| candidate).collect();
        }
        if state
            .challenger_since
            .map(|since| now.duration_since(since) < CHALLENGER_DEBOUNCE)
            .unwrap_or(true)
        {
            scored.swap(0, current_index);
        }
        scored.into_iter().map(|(candidate, _)| candidate).collect()
    }

    pub fn record_success(&self, profile_id: &str, route_id: &str, elapsed: Duration) {
        let Ok(mut profiles) = self.profiles.lock() else {
            return;
        };
        let state = profiles.entry(profile_id.to_string()).or_default();
        let observation = state.observations.entry(route_id.to_string()).or_default();
        let measured_rtt = elapsed.as_secs_f64() * 1_000.0;
        observation.total = observation.total.saturating_add(1);
        observation.consecutive_failures = 0;
        observation.succeeded = true;
        observation.rtt_ms = if observation.rtt_ms > 0.0 {
            observation.rtt_ms * 0.75 + measured_rtt * 0.25
        } else {
            measured_rtt
        };
        if state.selected_route_id != route_id {
            state.selected_route_id = route_id.to_string();
            state.selected_at = Some(Instant::now());
        }
        state.challenger_route_id.clear();
        state.challenger_since = None;
    }

    pub fn record_failure(&self, profile_id: &str, route_id: &str) {
        let Ok(mut profiles) = self.profiles.lock() else {
            return;
        };
        let state = profiles.entry(profile_id.to_string()).or_default();
        let observation = state.observations.entry(route_id.to_string()).or_default();
        observation.total = observation.total.saturating_add(1);
        observation.failures = observation.failures.saturating_add(1);
        observation.consecutive_failures = observation.consecutive_failures.saturating_add(1);
    }
}

fn score_candidate(candidate: &RouteCandidate, observation: Option<&RouteObservation>) -> f64 {
    let observed_health = observation.map(|value| {
        if value.consecutive_failures >= 3 {
            RouteHealth::Offline
        } else if value.consecutive_failures > 0 {
            RouteHealth::Degraded
        } else if value.succeeded {
            RouteHealth::Healthy
        } else {
            candidate.health
        }
    });
    let health = observed_health.unwrap_or(candidate.health);
    let health_score = match health {
        RouteHealth::Healthy => 100.0,
        RouteHealth::Unknown => 65.0,
        RouteHealth::Degraded => 40.0,
        RouteHealth::Offline => return f64::NEG_INFINITY,
    };
    let rtt_ms = observation
        .filter(|value| value.rtt_ms > 0.0)
        .map(|value| value.rtt_ms)
        .unwrap_or(candidate.rtt_ms);
    let latency_penalty = if rtt_ms > 0.0 {
        (rtt_ms / 8.0).min(35.0)
    } else {
        8.0
    };
    let failure_rate = observation
        .filter(|value| value.total > 0)
        .map(|value| value.failures as f64 / value.total as f64)
        .unwrap_or(0.0);
    let consecutive_failures = observation
        .map(|value| value.consecutive_failures)
        .unwrap_or(0);
    health_score
        - latency_penalty
        - failure_rate * 60.0
        - f64::from(consecutive_failures.min(5)) * 8.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: &str, health: RouteHealth, rtt_ms: f64) -> RouteCandidate {
        RouteCandidate {
            id: id.to_string(),
            kind: "relay-via-server".to_string(),
            endpoint: format!("https://{id}.example"),
            health,
            rtt_ms,
        }
    }

    #[test]
    fn initial_selection_scores_health_and_rtt() {
        let runtime = ServerRouteRuntime::default();
        let ordered = runtime.order_candidates(
            "profile",
            vec![
                candidate("slow", RouteHealth::Healthy, 160.0),
                candidate("degraded", RouteHealth::Degraded, 1.0),
                candidate("fast", RouteHealth::Healthy, 8.0),
            ],
            &HashSet::new(),
        );

        assert_eq!(ordered[0].id, "fast");
        assert_eq!(ordered[1].id, "slow");
        assert_eq!(ordered[2].id, "degraded");
    }

    #[test]
    fn sticky_hysteresis_and_debounce_prevent_route_flapping() {
        let runtime = ServerRouteRuntime::default();
        runtime.record_success("profile", "current", Duration::from_millis(20));
        let routes = vec![
            candidate("current", RouteHealth::Healthy, 40.0),
            candidate("challenger", RouteHealth::Healthy, 1.0),
        ];

        let sticky = runtime.order_candidates("profile", routes.clone(), &HashSet::new());
        assert_eq!(sticky[0].id, "current");

        {
            let mut profiles = runtime.profiles.lock().unwrap();
            profiles.get_mut("profile").unwrap().selected_at =
                Some(Instant::now() - STICKY_DURATION - Duration::from_millis(1));
        }
        let hysteresis = runtime.order_candidates(
            "profile",
            vec![
                candidate("current", RouteHealth::Healthy, 40.0),
                candidate("challenger", RouteHealth::Healthy, 1.0),
            ],
            &HashSet::new(),
        );
        assert_eq!(hysteresis[0].id, "current");

        runtime.record_failure("profile", "current");
        let debouncing = runtime.order_candidates(
            "profile",
            vec![
                candidate("current", RouteHealth::Degraded, 300.0),
                candidate("challenger", RouteHealth::Healthy, 1.0),
            ],
            &HashSet::new(),
        );
        assert_eq!(debouncing[0].id, "current");
        {
            let mut profiles = runtime.profiles.lock().unwrap();
            profiles.get_mut("profile").unwrap().challenger_since =
                Some(Instant::now() - CHALLENGER_DEBOUNCE - Duration::from_millis(1));
        }
        let switched = runtime.order_candidates(
            "profile",
            vec![
                candidate("current", RouteHealth::Degraded, 300.0),
                candidate("challenger", RouteHealth::Healthy, 1.0),
            ],
            &HashSet::new(),
        );
        assert_eq!(switched[0].id, "challenger");
    }

    #[test]
    fn failed_route_is_penalized_and_can_be_excluded_for_immediate_retry() {
        let runtime = ServerRouteRuntime::default();
        let routes = vec![
            candidate("a", RouteHealth::Healthy, 1.0),
            candidate("b", RouteHealth::Healthy, 20.0),
        ];
        assert_eq!(
            runtime.order_candidates("profile", routes.clone(), &HashSet::new())[0].id,
            "a"
        );
        runtime.record_failure("profile", "a");
        let excluded = HashSet::from(["a".to_string()]);
        assert_eq!(
            runtime.order_candidates("profile", routes, &excluded)[0].id,
            "b"
        );
    }
}
