#!/usr/bin/env bash
# =============================================================================
# datacat Kubernetes 설치 스크립트
# =============================================================================
# OpenTelemetry Operator를 설치하고 datacat 자동 계측을 구성합니다.
#
# 사용법:
#   DATACAT_HOST=datacat.example.com:4317 bash install.sh
#
# 전제조건: kubectl, helm (v3+)
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${BLUE}[datacat-k8s]${RESET} $*"; }
success() { echo -e "${GREEN}[datacat-k8s]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[datacat-k8s]${RESET} $*"; }
error()   { echo -e "${RED}[datacat-k8s] ERROR:${RESET} $*" >&2; exit 1; }

DATACAT_HOST="${DATACAT_HOST:-}"
DATACAT_NAMESPACE="${DATACAT_NAMESPACE:-datacat}"
OTEL_OPERATOR_VERSION="${OTEL_OPERATOR_VERSION:-0.115.0}"

[[ -z "$DATACAT_HOST" ]] && error "DATACAT_HOST가 필요합니다. 예: DATACAT_HOST=datacat.example.com:4317"

command -v kubectl &>/dev/null || error "kubectl이 필요합니다."
command -v helm    &>/dev/null || error "helm v3가 필요합니다."

echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  datacat Kubernetes 설치${RESET}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "  Collector: ${BOLD}${DATACAT_HOST}${RESET}"
echo -e "  Namespace: ${BOLD}${DATACAT_NAMESPACE}${RESET}"
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── 1. cert-manager 설치 (OTel Operator 의존성) ─────────────────────────────
info "1/4 cert-manager 확인 중..."
if kubectl get namespace cert-manager &>/dev/null; then
  info "cert-manager 이미 설치됨"
else
  info "cert-manager 설치 중..."
  kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
  info "cert-manager 준비 대기..."
  kubectl wait --for=condition=Available deployment/cert-manager \
    -n cert-manager --timeout=120s
  kubectl wait --for=condition=Available deployment/cert-manager-webhook \
    -n cert-manager --timeout=120s
  success "cert-manager 설치 완료"
fi

# ─── 2. OpenTelemetry Operator 설치 ──────────────────────────────────────────
info "2/4 OpenTelemetry Operator 설치 중 (v${OTEL_OPERATOR_VERSION})..."

helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts 2>/dev/null || true
helm repo update open-telemetry

helm upgrade --install opentelemetry-operator open-telemetry/opentelemetry-operator \
  --namespace opentelemetry-operator-system \
  --create-namespace \
  --version "${OTEL_OPERATOR_VERSION}" \
  --set "manager.collectorImage.repository=otel/opentelemetry-collector-contrib" \
  --wait

success "OpenTelemetry Operator 설치 완료"

# ─── 3. Instrumentation CR 배포 ─────────────────────────────────────────────
info "3/4 Instrumentation CR 배포 중..."

kubectl create namespace "${DATACAT_NAMESPACE}" 2>/dev/null || true

# DATACAT_HOST를 치환하여 instrumentation.yaml 적용
sed "s|DATACAT_HOST_PLACEHOLDER|${DATACAT_HOST}|g" \
  "${SCRIPT_DIR}/instrumentation.yaml" | kubectl apply -f -

success "Instrumentation CR 배포 완료"

# ─── 4. OTel Collector 게이트웨이 배포 ───────────────────────────────────────
info "4/4 OTel Collector 게이트웨이 배포 중..."

sed "s|DATACAT_HOST_PLACEHOLDER|${DATACAT_HOST}|g" \
  "${SCRIPT_DIR}/otelcollector.yaml" | kubectl apply -f -

success "OTel Collector 게이트웨이 배포 완료"

# ─── 완료 안내 ────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
success "설치 완료!"
echo ""
echo -e "${BOLD}서비스 자동 계측 활성화 방법:${RESET}"
echo ""
echo -e "  ${BOLD}네임스페이스 전체 적용 (권장):${RESET}"
echo -e "  ${GREEN}kubectl annotate namespace <your-namespace> \\"
echo -e "    instrumentation.opentelemetry.io/inject-java=datacat/${DATACAT_NAMESPACE} \\"
echo -e "    instrumentation.opentelemetry.io/inject-python=datacat/${DATACAT_NAMESPACE} \\"
echo -e "    instrumentation.opentelemetry.io/inject-nodejs=datacat/${DATACAT_NAMESPACE}${RESET}"
echo ""
echo -e "  ${BOLD}개별 Deployment 적용:${RESET}"
echo -e "  ${GREEN}kubectl patch deployment my-app -p \\"
echo -e "    '{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"instrumentation.opentelemetry.io/inject-java\":\"datacat/${DATACAT_NAMESPACE}\"}}}}}' ${RESET}"
echo ""
echo -e "  이후 pod를 재시작하면 OTel agent가 자동으로 inject됩니다."
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
