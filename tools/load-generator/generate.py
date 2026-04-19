#!/usr/bin/env python3
"""
datacat 부하 생성기
사용법: python generate.py --rate 1000 --duration 60 --endpoint localhost:4317
         python generate.py --logs --log-rate 200 --duration 60
         python generate.py --rate 1000 --logs --log-rate 200 --duration 60  # 트레이스+로그 동시
옵션:
  --rate        초당 스팬 수 (기본 1000)
  --log-rate    초당 로그 수 (기본 100)  --logs 플래그와 함께 사용
  --logs        로그 생성 활성화
  --duration    실행 시간 초 (기본 60)
  --endpoint    OTLP gRPC 엔드포인트 (기본 localhost:4317)
  --workers     워커 스레드 수 (기본 4)
  --errors      에러 비율 0~1 (기본 0.05)
"""
import argparse
import time
import random
import threading
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter
import logging

SERVICES = [
    "api-gateway", "user-service", "order-service",
    "payment-service", "inventory-service"
]

OPERATIONS = [
    "GET /users/{id}", "POST /orders", "GET /products",
    "PUT /cart", "DELETE /sessions", "POST /payments"
]

# 로그 메시지 템플릿 (Log Metric Rules 테스트용으로 다양한 패턴 포함)
LOG_TEMPLATES = {
    "INFO": [
        "Request processed successfully in {latency}ms",
        "User {user_id} logged in",
        "Order {order_id} created",
        "Cache hit for key {key}",
        "DB query completed in {latency}ms",
        "Payment {payment_id} authorized",
        "Inventory updated for product {product_id}",
    ],
    "WARN": [
        "Slow query detected: {latency}ms exceeded threshold",
        "Retry attempt {attempt} for service {service}",
        "High memory usage: {pct}% of limit",
        "Rate limit approaching for tenant {tenant}",
        "Circuit breaker half-open for {service}",
    ],
    "ERROR": [
        "Exception in {service}: NullPointerException at line {line}",
        "Database connection failed: timeout after {latency}ms",
        "Payment {payment_id} declined: insufficient funds",
        "Service {service} returned 500",
        "Failed to process order {order_id}: validation error",
    ],
    "DEBUG": [
        "Entering handler {handler} with params {params}",
        "SQL: SELECT * FROM {table} WHERE id={id}",
        "Cache miss for key {key}, fetching from DB",
        "gRPC call to {service} took {latency}ms",
    ],
}

SEVERITY_WEIGHTS = [("DEBUG", 0.15), ("INFO", 0.60), ("WARN", 0.15), ("ERROR", 0.10)]


def _random_severity():
    r = random.random()
    acc = 0.0
    for sev, w in SEVERITY_WEIGHTS:
        acc += w
        if r < acc:
            return sev
    return "INFO"


def _render_template(tmpl: str, service: str) -> str:
    return tmpl.format(
        latency=random.randint(1, 3000),
        user_id=random.randint(1000, 9999),
        order_id=f"ORD-{random.randint(10000, 99999)}",
        payment_id=f"PAY-{random.randint(10000, 99999)}",
        product_id=random.randint(1, 500),
        key=f"cache:{service}:{random.randint(1, 100)}",
        attempt=random.randint(1, 5),
        service=random.choice(SERVICES),
        pct=random.randint(70, 99),
        tenant=f"tenant-{random.randint(1, 10)}",
        line=random.randint(10, 500),
        handler=f"handle_{random.choice(['create','update','delete','get'])}",
        params=f"{{id: {random.randint(1,100)}}}",
        table=random.choice(["users", "orders", "products", "payments"]),
        id=random.randint(1, 10000),
    )


def run_trace_worker(tracer, rate_per_worker, duration, errors_pct=0.05):
    interval = 1.0 / max(rate_per_worker, 1)
    end_time = time.time() + duration

    while time.time() < end_time:
        start = time.time()
        with tracer.start_as_current_span(
            random.choice(OPERATIONS),
            attributes={
                "http.method": random.choice(["GET", "POST", "PUT"]),
                "http.route": f"/api/v{random.randint(1,2)}/resource",
                "http.status_code": 500 if random.random() < errors_pct else 200,
                "db.system": "postgresql",
                "db.name": "appdb",
            }
        ) as span:
            sleep_ms = min(2000, max(1, int(random.lognormvariate(3.5, 1.2))))
            time.sleep(sleep_ms / 1000)
            if random.random() < errors_pct:
                span.set_status(trace.StatusCode.ERROR, "simulated error")

        elapsed = time.time() - start
        if elapsed < interval:
            time.sleep(interval - elapsed)


def run_log_worker(logger, service, rate_per_worker, duration):
    interval = 1.0 / max(rate_per_worker, 1)
    end_time = time.time() + duration

    level_map = {
        "DEBUG": logging.DEBUG,
        "INFO": logging.INFO,
        "WARN": logging.WARNING,
        "ERROR": logging.ERROR,
    }

    while time.time() < end_time:
        start = time.time()
        sev = _random_severity()
        tmpl = random.choice(LOG_TEMPLATES[sev])
        body = _render_template(tmpl, service)
        logger.log(level_map[sev], body, extra={"service": service})

        elapsed = time.time() - start
        if elapsed < interval:
            time.sleep(interval - elapsed)


def main():
    parser = argparse.ArgumentParser(description="datacat 부하 생성기")
    parser.add_argument("--rate", type=int, default=1000, help="총 초당 스팬 수")
    parser.add_argument("--duration", type=int, default=60)
    parser.add_argument("--endpoint", default="localhost:4317")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--errors", type=float, default=0.05)
    parser.add_argument("--logs", action="store_true", help="로그 생성 활성화")
    parser.add_argument("--log-rate", type=int, default=100, help="총 초당 로그 수")
    parser.add_argument("--logs-only", action="store_true", help="로그만 생성 (트레이스 생략)")
    args = parser.parse_args()

    generate_traces = not args.logs_only
    generate_logs = args.logs or args.logs_only

    print(f"[datacat load-gen] endpoint={args.endpoint} duration={args.duration}s")
    if generate_traces:
        print(f"[datacat load-gen] traces: rate={args.rate}/s workers={args.workers} errors={args.errors:.0%}")
    if generate_logs:
        print(f"[datacat load-gen] logs:   rate={args.log_rate}/s workers={args.workers}")

    threads = []

    # ── 트레이스 워커 ─────────────────────────────────────────────────────────
    if generate_traces:
        rate_per_worker = args.rate // args.workers
        for svc in SERVICES[:args.workers]:
            resource = Resource.create({"service.name": svc, "deployment.environment": "load-test"})
            provider = TracerProvider(resource=resource)
            exporter = OTLPSpanExporter(endpoint=args.endpoint, insecure=True)
            provider.add_span_processor(BatchSpanProcessor(
                exporter,
                max_queue_size=10000,
                max_export_batch_size=512,
                schedule_delay_millis=100,
            ))
            tracer = provider.get_tracer("load-generator")
            t = threading.Thread(
                target=run_trace_worker,
                args=(tracer, rate_per_worker, args.duration, args.errors),
                daemon=True,
            )
            threads.append(t)
            t.start()

    # ── 로그 워커 ─────────────────────────────────────────────────────────────
    if generate_logs:
        log_rate_per_worker = max(1, args.log_rate // args.workers)
        for svc in SERVICES[:args.workers]:
            resource = Resource.create({"service.name": svc, "deployment.environment": "load-test"})
            log_provider = LoggerProvider(resource=resource)
            log_exporter = OTLPLogExporter(endpoint=args.endpoint, insecure=True)
            log_provider.add_log_record_processor(BatchLogRecordProcessor(log_exporter))

            handler = LoggingHandler(level=logging.DEBUG, logger_provider=log_provider)
            logger = logging.getLogger(f"datacat.loadgen.{svc}")
            logger.setLevel(logging.DEBUG)
            logger.addHandler(handler)
            logger.propagate = False

            t = threading.Thread(
                target=run_log_worker,
                args=(logger, svc, log_rate_per_worker, args.duration),
                daemon=True,
            )
            threads.append(t)
            t.start()

    # ── 진행 모니터링 ─────────────────────────────────────────────────────────
    start_time = time.time()
    while any(t.is_alive() for t in threads):
        elapsed = time.time() - start_time
        print(f"\r[{elapsed:.0f}s/{args.duration}s] 실행 중...", end="", flush=True)
        time.sleep(5)

    print(f"\n완료.")
    if generate_traces:
        print(f"  트레이스: 약 {args.rate * args.duration:,} spans")
    if generate_logs:
        print(f"  로그:     약 {args.log_rate * args.duration:,} records")

if __name__ == "__main__":
    main()
