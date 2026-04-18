#!/usr/bin/env python3
"""
datacat 부하 생성기
사용법: python generate.py --rate 10000 --duration 60 --endpoint localhost:4317
- rate: 초당 스팬 수 (기본 10000)
- duration: 실행 시간 초 (기본 60)
- endpoint: OTLP gRPC 엔드포인트
- services: 시뮬레이션할 서비스 수 (기본 5)
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

SERVICES = [
    "api-gateway", "user-service", "order-service",
    "payment-service", "inventory-service"
]

OPERATIONS = [
    "GET /users/{id}", "POST /orders", "GET /products",
    "PUT /cart", "DELETE /sessions", "POST /payments"
]

def run_worker(tracer, rate_per_worker, duration, errors_pct=0.05):
    """단일 워커: 지정 rate로 스팬 생성"""
    interval = 1.0 / rate_per_worker
    end_time = time.time() + duration
    count = 0

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
            # 응답시간 시뮬레이션 (로그 정규분포: 10ms~2000ms)
            sleep_ms = min(2000, max(1, int(random.lognormvariate(3.5, 1.2))))
            time.sleep(sleep_ms / 1000)

            if random.random() < errors_pct:
                span.set_status(trace.StatusCode.ERROR, "simulated error")

            count += 1

        elapsed = time.time() - start
        if elapsed < interval:
            time.sleep(interval - elapsed)

    return count

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--rate", type=int, default=1000, help="총 초당 스팬 수")
    parser.add_argument("--duration", type=int, default=60)
    parser.add_argument("--endpoint", default="localhost:4317")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--errors", type=float, default=0.05)
    args = parser.parse_args()

    rate_per_worker = args.rate // args.workers

    print(f"[datacat load-gen] rate={args.rate}/s workers={args.workers} duration={args.duration}s")
    print(f"[datacat load-gen] endpoint={args.endpoint}")

    # 서비스별 TracerProvider 생성
    providers = []
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
        providers.append(provider)

    threads = []
    start_time = time.time()

    for i, provider in enumerate(providers):
        tracer = provider.get_tracer("load-generator")
        t = threading.Thread(
            target=run_worker,
            args=(tracer, rate_per_worker, args.duration, args.errors),
            daemon=True,
        )
        threads.append(t)
        t.start()

    # 진행 상황 모니터링
    while any(t.is_alive() for t in threads):
        elapsed = time.time() - start_time
        print(f"\r[{elapsed:.0f}s/{args.duration}s] 실행 중...", end="", flush=True)
        time.sleep(5)

    print(f"\n완료. 총 {args.duration}초, 예상 {args.rate * args.duration:,} spans")

if __name__ == "__main__":
    main()
