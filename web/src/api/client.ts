/**
 * client.ts — datacat REST API 클라이언트
 *
 * Phase 1: Dogeon 백엔드와 연동
 *   GET /api/v1/xview   — scatter 포인트 + 통계
 *   GET /api/v1/services — 서비스 목록
 */

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

// ─── Request params ────────────────────────────────────────────────────────────

export interface XViewParams {
  start: number;      // unix ms
  end: number;        // unix ms
  service?: string;
  tenantId?: string;
  step?: number;
}

// ─── Response shapes ───────────────────────────────────────────────────────────

/** Wire format from /api/v1/xview (단일 포인트) */
export interface XViewPointWire {
  t: number;    // unix timestamp ms
  d: number;    // duration_ns
  s: 0 | 1;    // status: 0=ok, 1=error
}

export interface XViewStats {
  total: number;
  errors: number;
  p50_ns: number;
  p95_ns: number;
  p99_ns: number;
}

export interface XViewResponse {
  points: XViewPointWire[];
  stats: XViewStats;
}

export interface Service {
  name: string;
  env: string;
}

// ─── API functions ─────────────────────────────────────────────────────────────

export async function fetchXView(
  params: XViewParams,
  signal?: AbortSignal,
): Promise<XViewResponse> {
  const qs = new URLSearchParams({
    start: String(params.start),
    end: String(params.end),
    ...(params.service   ? { service:   params.service }           : {}),
    ...(params.tenantId  ? { tenant_id: params.tenantId }          : {}),
    ...(params.step !== undefined ? { step: String(params.step) }  : {}),
  });

  const resp = await fetch(`${API_BASE}/api/v1/xview?${qs}`, { signal });
  if (!resp.ok) throw new Error(`xview fetch failed: ${resp.status}`);
  return resp.json() as Promise<XViewResponse>;
}

export async function fetchServices(signal?: AbortSignal): Promise<Service[]> {
  const resp = await fetch(`${API_BASE}/api/v1/services`, { signal });
  if (!resp.ok) return [];
  return resp.json() as Promise<Service[]>;
}

// ─── Metrics API ───────────────────────────────────────────────────────────────

export interface MetricPoint {
  t: number; // unix ms
  v: number; // value
}

export interface MetricInfo {
  name: string;
  service: string;
}

export async function fetchMetricNames(): Promise<MetricInfo[]> {
  const resp = await fetch(`${API_BASE}/api/v1/metrics`);
  if (!resp.ok) throw new Error(`metric names fetch failed: ${resp.status}`);
  return resp.json() as Promise<MetricInfo[]>;
}

// ─── Profiling API ─────────────────────────────────────────────────────────────

export interface ProfileInfo {
  id: string;
  service: string;
  type: string;       // cpu, heap, goroutine
  timestamp: number;  // unix ms
  size_bytes: number;
}

export interface ProfilesResponse {
  profiles: ProfileInfo[];
}

export interface FoldedFrame {
  stack: string;   // "func1;func2;func3"
  value: number;
}

export interface FlamegraphResponse {
  profile_id: string;
  service: string;
  profile_type: string;
  timestamp: number;
  folded: FoldedFrame[];
  data_base64?: string;
  format?: 'pprof' | 'folded';
}

export async function fetchProfiles(params: {
  service?: string;
  start: number;
  end: number;
  type?: string;
  tenantId?: string;
}): Promise<ProfilesResponse> {
  const qs = new URLSearchParams({
    start: String(params.start),
    end:   String(params.end),
    ...(params.service  ? { service:   params.service }  : {}),
    ...(params.type     ? { type:      params.type }      : {}),
    ...(params.tenantId ? { tenant_id: params.tenantId }  : {}),
  });

  const resp = await fetch(`${API_BASE}/api/v1/profiles?${qs}`);
  if (!resp.ok) throw new Error(`profiles fetch failed: ${resp.status}`);
  return resp.json() as Promise<ProfilesResponse>;
}

export async function fetchFlamegraph(profileId: string): Promise<FlamegraphResponse> {
  const resp = await fetch(`${API_BASE}/api/v1/profiles/${encodeURIComponent(profileId)}/flamegraph`);
  if (!resp.ok) throw new Error(`flamegraph fetch failed: ${resp.status}`);
  return resp.json() as Promise<FlamegraphResponse>;
}

// ─── Insights / AI Auto-Ops API ───────────────────────────────────────────────

// Anomaly Detection

export interface AnomalyReport {
  service: string;
  metric: string;       // "error_rate" | "p99_latency_ms"
  score: number;        // z-score
  baseline: number;
  current: number;
  detected_at: number;  // unix ms
}

export interface AnalyzeRequest {
  tenant_id?: string;
  window_minutes?: number;
}

export interface AnalyzeResponse {
  anomalies: AnomalyReport[];
  total: number;
}

// Pattern Detection

export type PatternType = 'Surge' | 'Waterfall' | 'Droplet' | 'Wave';

export interface PatternDetected {
  pattern: PatternType;
  service: string;
  confidence: number;
  description: string;
  detected_at: number;
}

export interface PatternsResponse {
  patterns: PatternDetected[];
}

// Chat

export interface ChatContext {
  service?: string;
  start?: number;
  end?: number;
}

export interface ChatRequest {
  message: string;
  tenant_id?: string;
  context?: ChatContext;
}

export interface Finding {
  severity: 'info' | 'warning' | 'critical';
  message: string;
  service?: string;
  metric?: string;
  value?: number;
}

export interface ChatResponse {
  reply: string;
  findings: Finding[];
  suggested_actions: string[];
}

export async function fetchAnomalies(req: AnalyzeRequest): Promise<AnalyzeResponse> {
  const resp = await fetch(`${API_BASE}/api/v1/insights/analyze`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(req),
  });
  if (!resp.ok) throw new Error(`analyze fetch failed: ${resp.status}`);
  return resp.json() as Promise<AnalyzeResponse>;
}

export async function fetchPatterns(params: {
  start: number;
  end: number;
  service?: string;
  tenantId?: string;
}): Promise<PatternsResponse> {
  const qs = new URLSearchParams({
    start: String(params.start),
    end:   String(params.end),
    ...(params.service  ? { service:   params.service }  : {}),
    ...(params.tenantId ? { tenant_id: params.tenantId } : {}),
  });
  const resp = await fetch(`${API_BASE}/api/v1/insights/patterns?${qs}`);
  if (!resp.ok) throw new Error(`patterns fetch failed: ${resp.status}`);
  return resp.json() as Promise<PatternsResponse>;
}

export async function sendChatMessage(req: ChatRequest): Promise<ChatResponse> {
  const resp = await fetch(`${API_BASE}/api/v1/insights/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(req),
  });
  if (!resp.ok) throw new Error(`chat fetch failed: ${resp.status}`);
  return resp.json() as Promise<ChatResponse>;
}

// ─── Query Range (multi-series) API ───────────────────────────────────────────

export interface MetricSeries {
  labels: Record<string, string>;
  data: MetricPoint[];
}

export interface QueryRangeResponse {
  metric: string;
  series: MetricSeries[];
}

export async function fetchQueryRange(params: {
  query: string;
  start: number;
  end: number;
  step: number;
  tenantId?: string;
  groupBy?: string;
  agg?: string;
  service?: string;
}): Promise<QueryRangeResponse> {
  const qs = new URLSearchParams({
    query: params.query,
    start: String(params.start),
    end:   String(params.end),
    step:  String(params.step),
    ...(params.tenantId ? { tenant_id: params.tenantId } : {}),
    ...(params.groupBy  ? { group_by:  params.groupBy }  : {}),
    ...(params.agg      ? { agg:       params.agg }      : {}),
    ...(params.service  ? { service:   params.service }  : {}),
  });

  const resp = await fetch(`${API_BASE}/api/v1/query_range?${qs}`);
  if (!resp.ok) throw new Error(`query_range fetch failed: ${resp.status}`);
  return resp.json() as Promise<QueryRangeResponse>;
}

// ─── Log Metric Rules API ──────────────────────────────────────────────────────

export interface LogMetricRule {
  rule_id: string;
  metric_name: string;
  description: string;
  filter_type: string;
  filter_value: string;
  value_field: string;
  metric_type: number;
  group_by: string;
  enabled: boolean;
  created_at: number;
}

export interface CreateRuleRequest {
  metric_name: string;
  description?: string;
  filter_type: string;
  filter_value: string;
  value_field?: string;
  metric_type: number;
  group_by?: string;
}

export async function fetchLogMetricRules(tenantId = 'default'): Promise<LogMetricRule[]> {
  const qs = new URLSearchParams({ tenant_id: tenantId });
  const resp = await fetch(`${API_BASE}/api/v1/log-metric-rules?${qs}`);
  if (!resp.ok) throw new Error(`log-metric-rules fetch failed: ${resp.status}`);
  return resp.json() as Promise<LogMetricRule[]>;
}

export async function createLogMetricRule(rule: CreateRuleRequest): Promise<LogMetricRule> {
  const resp = await fetch(`${API_BASE}/api/v1/log-metric-rules`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(rule),
  });
  if (!resp.ok) throw new Error(`create rule failed: ${resp.status}`);
  return resp.json() as Promise<LogMetricRule>;
}

export async function deleteLogMetricRule(ruleId: string): Promise<void> {
  const resp = await fetch(`${API_BASE}/api/v1/log-metric-rules/${encodeURIComponent(ruleId)}`, {
    method: 'DELETE',
  });
  if (!resp.ok) throw new Error(`delete rule failed: ${resp.status}`);
}

// ─── Logs API ──────────────────────────────────────────────────────────────────

export type LogSeverity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  id: string;
  timestamp: number;   // unix ms
  severity: LogSeverity;
  service: string;
  message: string;
  trace_id?: string;
  attrs?: Record<string, string>;
}

export interface LogsResponse {
  logs: LogEntry[];
  total: number;
}

export async function fetchLogs(params: {
  service?: string;
  severity?: LogSeverity;
  query?: string;
  start: number;
  end: number;
  limit?: number;
  tenantId?: string;
}): Promise<LogsResponse> {
  const qs = new URLSearchParams({
    start: String(params.start),
    end:   String(params.end),
    ...(params.service  ? { service:   params.service }        : {}),
    ...(params.severity ? { severity:  params.severity }       : {}),
    ...(params.query    ? { q:         params.query }          : {}),
    ...(params.limit !== undefined ? { limit: String(params.limit) } : {}),
    ...(params.tenantId ? { tenant_id: params.tenantId }       : {}),
  });

  const resp = await fetch(`${API_BASE}/api/v1/logs?${qs}`);
  if (!resp.ok) throw new Error(`logs fetch failed: ${resp.status}`);
  return resp.json() as Promise<LogsResponse>;
}
