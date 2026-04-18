//! 공유 애플리케이션 상태
//!
//! ClickHouse 클라이언트를 모든 핸들러에 공유한다.

/// datacat-insights 서비스 공유 상태.
#[derive(Clone)]
pub struct AppState {
    /// ClickHouse HTTP 클라이언트
    pub ch_client: clickhouse::Client,
    /// Ollama base URL (환경변수 OLLAMA_URL 미설정 시 None)
    pub ollama_url: Option<String>,
    /// 재사용 가능한 HTTP 클라이언트 (Ollama 프록시용)
    pub http_client: reqwest::Client,
}
