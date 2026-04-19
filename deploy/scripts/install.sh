#!/usr/bin/env bash
# =============================================================================
# datacat Universal Installer — VM / Bare Metal
# =============================================================================
# 사용법:
#   curl -sSL https://<datacat-host>/install.sh | \
#     DATACAT_HOST=<host>:4317 \
#     DATACAT_SERVICE=<service-name> \
#     DATACAT_LANG=java \
#     bash
#
# 필수 환경변수:
#   DATACAT_HOST     — datacat collector 주소 (예: datacat.example.com:4317)
#   DATACAT_SERVICE  — 이 서비스의 이름
#   DATACAT_LANG     — java | python | nodejs | go
#
# 선택 환경변수:
#   DATACAT_ENV      — 환경 이름 (기본: production)
#   DATACAT_TENANT   — 테넌트 ID (기본: default)
#   DATACAT_PROTOCOL — grpc | http (기본: grpc)
#   DATACAT_PROFILING — true | false (기본: false) — pprof/JFR 프로파일링 활성화
#   INSTALL_DIR      — 설치 디렉터리 (기본: ~/.datacat)
# =============================================================================

set -euo pipefail

# ─── 색상 출력 헬퍼 ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}[datacat]${RESET} $*"; }
success() { echo -e "${GREEN}[datacat]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[datacat]${RESET} $*"; }
error()   { echo -e "${RED}[datacat] ERROR:${RESET} $*" >&2; exit 1; }

# ─── 파라미터 ─────────────────────────────────────────────────────────────────
DATACAT_HOST="${DATACAT_HOST:-}"
DATACAT_SERVICE="${DATACAT_SERVICE:-}"
DATACAT_LANG="${DATACAT_LANG:-}"
DATACAT_ENV="${DATACAT_ENV:-production}"
DATACAT_TENANT="${DATACAT_TENANT:-default}"
DATACAT_PROTOCOL="${DATACAT_PROTOCOL:-grpc}"
DATACAT_PROFILING="${DATACAT_PROFILING:-false}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.datacat}"

# ─── 필수값 검증 ──────────────────────────────────────────────────────────────
[[ -z "$DATACAT_HOST" ]]    && error "DATACAT_HOST가 설정되지 않았습니다. 예: DATACAT_HOST=datacat.example.com:4317"
[[ -z "$DATACAT_SERVICE" ]] && error "DATACAT_SERVICE가 설정되지 않았습니다. 예: DATACAT_SERVICE=my-api"

# ─── 언어 자동 감지 ───────────────────────────────────────────────────────────
detect_lang() {
  if [[ -f "pom.xml" ]] || [[ -f "build.gradle" ]] || ls ./*.jar 2>/dev/null | grep -q .; then
    echo "java"
  elif [[ -f "package.json" ]]; then
    echo "nodejs"
  elif [[ -f "requirements.txt" ]] || [[ -f "pyproject.toml" ]] || [[ -f "setup.py" ]]; then
    echo "python"
  elif [[ -f "go.mod" ]]; then
    echo "go"
  else
    echo ""
  fi
}

if [[ -z "$DATACAT_LANG" ]]; then
  DATACAT_LANG=$(detect_lang)
  if [[ -z "$DATACAT_LANG" ]]; then
    error "언어를 감지할 수 없습니다. DATACAT_LANG=java|python|nodejs|go 를 명시하세요."
  fi
  info "언어 자동 감지: ${BOLD}${DATACAT_LANG}${RESET}"
fi

# ─── 설치 디렉터리 생성 ───────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"

OTLP_ENDPOINT="http://${DATACAT_HOST}"
COLLECTOR_HOST="${DATACAT_HOST%%:*}"
COLLECTOR_PORT="${DATACAT_HOST##*:}"

# ─── 언어별 설치 ──────────────────────────────────────────────────────────────

install_java() {
  info "Java OTel Agent 설치 중..."

  local agent_jar="$INSTALL_DIR/opentelemetry-javaagent.jar"
  local latest_url="https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar"

  if [[ ! -f "$agent_jar" ]]; then
    if command -v curl &>/dev/null; then
      curl -sSL "$latest_url" -o "$agent_jar"
    elif command -v wget &>/dev/null; then
      wget -qO "$agent_jar" "$latest_url"
    else
      error "curl 또는 wget이 필요합니다."
    fi
    success "Java agent 다운로드 완료: $agent_jar"
  else
    info "Java agent 이미 존재: $agent_jar"
  fi

  # 환경변수 설정 파일 생성
  cat > "$INSTALL_DIR/datacat-java.env" << EOF
# datacat Java OTel 설정 — source 또는 /etc/environment에 추가
JAVA_TOOL_OPTIONS=-javaagent:${agent_jar}
OTEL_SERVICE_NAME=${DATACAT_SERVICE}
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=${DATACAT_ENV},tenant.id=${DATACAT_TENANT}
OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_ENDPOINT}
OTEL_EXPORTER_OTLP_PROTOCOL=${DATACAT_PROTOCOL}
OTEL_TRACES_SAMPLER=always_on
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
EOF

  echo ""
  success "설치 완료! 다음 중 하나를 실행하세요:"
  echo ""
  echo -e "  ${BOLD}방법 1 — 환경변수 파일 사용:${RESET}"
  echo -e "  ${GREEN}source ${INSTALL_DIR}/datacat-java.env && java -jar your-app.jar${RESET}"
  echo ""
  echo -e "  ${BOLD}방법 2 — 직접 JVM 옵션 추가:${RESET}"
  echo -e "  ${GREEN}java -javaagent:${agent_jar} \\"
  echo    "    -Dotel.service.name=${DATACAT_SERVICE} \\"
  echo    "    -Dotel.exporter.otlp.endpoint=${OTLP_ENDPOINT} \\"
  echo -e "    -jar your-app.jar${RESET}"
  echo ""
  echo -e "  ${BOLD}방법 3 — systemd service 환경파일:${RESET}"
  echo -e "  EnvironmentFile=${INSTALL_DIR}/datacat-java.env"
}

install_python() {
  info "Python OTel SDK 설치 중..."

  if ! command -v pip3 &>/dev/null && ! command -v pip &>/dev/null; then
    error "pip이 필요합니다."
  fi

  local pip_cmd="pip3"
  command -v pip3 &>/dev/null || pip_cmd="pip"

  $pip_cmd install --quiet \
    opentelemetry-distro \
    opentelemetry-exporter-otlp-proto-grpc \
    opentelemetry-instrumentation

  # auto-instrumentation bootstrap (감지된 라이브러리에 맞는 instrument 설치)
  opentelemetry-bootstrap --action=install 2>/dev/null || true

  cat > "$INSTALL_DIR/datacat-python.env" << EOF
OTEL_SERVICE_NAME=${DATACAT_SERVICE}
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=${DATACAT_ENV},tenant.id=${DATACAT_TENANT}
OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_ENDPOINT}
OTEL_EXPORTER_OTLP_PROTOCOL=${DATACAT_PROTOCOL}
OTEL_TRACES_SAMPLER=always_on
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
EOF

  echo ""
  success "설치 완료! 다음과 같이 실행하세요:"
  echo ""
  echo -e "  ${GREEN}export \$(cat ${INSTALL_DIR}/datacat-python.env | xargs)"
  echo -e "  opentelemetry-instrument python your_app.py${RESET}"
  echo ""
  echo -e "  ${BOLD}Gunicorn/uWSGI:${RESET}"
  echo -e "  ${GREEN}opentelemetry-instrument gunicorn -w 4 your_app:app${RESET}"
}

install_nodejs() {
  info "Node.js OTel SDK 설치 중..."

  if ! command -v npm &>/dev/null; then
    error "npm이 필요합니다."
  fi

  npm install --save \
    @opentelemetry/sdk-node \
    @opentelemetry/auto-instrumentations-node \
    @opentelemetry/exporter-trace-otlp-grpc \
    @opentelemetry/exporter-metrics-otlp-grpc \
    @opentelemetry/exporter-logs-otlp-grpc \
    2>/dev/null

  # datacat tracing 초기화 파일 생성
  cat > "./datacat-tracing.js" << 'JSEOF'
// datacat-tracing.js — require 최우선 로딩 필요
// 사용: node -r ./datacat-tracing.js your-app.js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-grpc');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-grpc');
const { PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(),
    exportIntervalMillis: 10000,
  }),
  logRecordProcessor: new (require('@opentelemetry/sdk-logs').SimpleLogRecordProcessor)(
    new OTLPLogExporter()
  ),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown());
JSEOF

  cat > "$INSTALL_DIR/datacat-node.env" << EOF
OTEL_SERVICE_NAME=${DATACAT_SERVICE}
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=${DATACAT_ENV},tenant.id=${DATACAT_TENANT}
OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_ENDPOINT}
OTEL_EXPORTER_OTLP_PROTOCOL=${DATACAT_PROTOCOL}
OTEL_TRACES_SAMPLER=always_on
OTEL_LOGS_EXPORTER=otlp
OTEL_METRICS_EXPORTER=otlp
NODE_OPTIONS=--require ./datacat-tracing.js
EOF

  echo ""
  success "설치 완료! 다음과 같이 실행하세요:"
  echo ""
  echo -e "  ${GREEN}export \$(cat ${INSTALL_DIR}/datacat-node.env | xargs)"
  echo -e "  node your-app.js${RESET}"
  echo ""
  echo -e "  ${BOLD}또는 package.json scripts에 추가:${RESET}"
  echo -e "  ${GREEN}\"start\": \"node -r ./datacat-tracing.js your-app.js\"${RESET}"
}

install_go() {
  info "Go: 코드 레벨 SDK 설치가 필요합니다."
  echo ""
  warn "Go는 자동 계측을 지원하지 않아 코드에 SDK를 직접 추가해야 합니다."
  echo ""
  info "1. 패키지 추가:"
  echo -e "  ${GREEN}go get go.opentelemetry.io/otel \\"
  echo    "    go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc \\"
  echo    "    go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc \\"
  echo -e "    go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp${RESET}"
  echo ""

  # Go 초기화 코드 생성
  cat > "./datacat_otel.go" << GOEOF
// datacat_otel.go — OTel 초기화 코드 (main.go에서 호출)
package main

import (
	"context"
	"log"
	"os"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

func initDatacat(ctx context.Context) func() {
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		endpoint = "${OTLP_ENDPOINT}"
	}

	res := resource.NewWithAttributes(
		semconv.SchemaURL,
		semconv.ServiceName("${DATACAT_SERVICE}"),
		semconv.DeploymentEnvironment("${DATACAT_ENV}"),
	)

	traceExp, err := otlptracegrpc.New(ctx,
		otlptracegrpc.WithEndpoint(endpoint),
		otlptracegrpc.WithInsecure(),
	)
	if err != nil { log.Fatalf("trace exporter: %v", err) }

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExp),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.AlwaysSample()),
	)
	otel.SetTracerProvider(tp)

	metricExp, err := otlpmetricgrpc.New(ctx,
		otlpmetricgrpc.WithEndpoint(endpoint),
		otlpmetricgrpc.WithInsecure(),
	)
	if err != nil { log.Fatalf("metric exporter: %v", err) }

	mp := metric.NewMeterProvider(
		metric.WithReader(metric.NewPeriodicReader(metricExp, metric.WithInterval(10*time.Second))),
		metric.WithResource(res),
	)
	otel.SetMeterProvider(mp)

	return func() {
		tp.Shutdown(ctx)
		mp.Shutdown(ctx)
	}
}
GOEOF

  success "datacat_otel.go 생성 완료 — main()에서 initDatacat(ctx) 호출 후 반환된 shutdown 함수를 defer로 등록하세요."

  cat > "$INSTALL_DIR/datacat-go.env" << EOF
OTEL_SERVICE_NAME=${DATACAT_SERVICE}
OTEL_RESOURCE_ATTRIBUTES=deployment.environment=${DATACAT_ENV},tenant.id=${DATACAT_TENANT}
OTEL_EXPORTER_OTLP_ENDPOINT=${OTLP_ENDPOINT}
OTEL_EXPORTER_OTLP_PROTOCOL=${DATACAT_PROTOCOL}
EOF
}

# ─── 프로파일링 에이전트 설치 ────────────────────────────────────────────────
install_profiling() {
  info "프로파일링 에이전트 설치 중..."

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local profiling_script="${script_dir}/profiling-sender.sh"

  # profiling-sender.sh가 없으면 install.sh 옆에서 찾기
  if [[ ! -f "$profiling_script" ]]; then
    profiling_script="$INSTALL_DIR/profiling-sender.sh"
    curl -sSL "https://${COLLECTOR_HOST}/profiling-sender.sh" -o "$profiling_script" 2>/dev/null || true
  fi

  if [[ -f "$profiling_script" ]]; then
    chmod +x "$profiling_script"

    # systemd 서비스 유닛 생성
    cat > "$INSTALL_DIR/datacat-profiling.service" << EOF
[Unit]
Description=datacat Profiling Sender — ${DATACAT_SERVICE}
After=network.target

[Service]
Type=simple
Environment=DATACAT_HOST=${DATACAT_HOST}
Environment=DATACAT_SERVICE=${DATACAT_SERVICE}
Environment=DATACAT_ENV=${DATACAT_ENV}
Environment=DATACAT_TENANT=${DATACAT_TENANT}
Environment=DATACAT_LANG=${DATACAT_LANG}
ExecStart=${profiling_script}
Restart=always
RestartSec=30

[Install]
WantedBy=multi-user.target
EOF
    echo ""
    info "프로파일링 systemd 서비스 등록:"
    echo -e "  ${GREEN}sudo cp ${INSTALL_DIR}/datacat-profiling.service /etc/systemd/system/"
    echo -e "  sudo systemctl daemon-reload"
    echo -e "  sudo systemctl enable --now datacat-profiling${RESET}"
  fi
}

# ─── 메인 ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  datacat 설치${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  서비스:   ${BOLD}${DATACAT_SERVICE}${RESET}"
echo -e "  언어:     ${BOLD}${DATACAT_LANG}${RESET}"
echo -e "  Collector: ${BOLD}${DATACAT_HOST}${RESET}"
echo -e "  환경:     ${BOLD}${DATACAT_ENV}${RESET}"
echo ""

case "$DATACAT_LANG" in
  java)   install_java   ;;
  python) install_python ;;
  nodejs|node) install_nodejs ;;
  go)     install_go     ;;
  *)      error "지원하지 않는 언어: ${DATACAT_LANG}. java | python | nodejs | go 중 선택하세요." ;;
esac

if [[ "$DATACAT_PROFILING" == "true" ]]; then
  install_profiling
fi

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
success "datacat 연결 설정 완료"
echo -e "  설정 파일: ${INSTALL_DIR}/"
echo -e "  datacat UI: http://${COLLECTOR_HOST}:3000"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
