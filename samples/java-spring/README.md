# datacat Java Spring Boot 샘플

## 빠른 시작

1. 전제조건: JDK 17+, Maven 또는 Gradle
2. OTel Java Agent로 자동 계측:

```bash
# OTel Java agent 다운로드
curl -L https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/latest/download/opentelemetry-javaagent.jar \
  -o opentelemetry-javaagent.jar

# 앱 실행 (datacat collector에 연결)
java -javaagent:opentelemetry-javaagent.jar \
  -Dotel.service.name=spring-sample \
  -Dotel.exporter.otlp.endpoint=http://localhost:4317 \
  -Dotel.exporter.otlp.protocol=grpc \
  -Dotel.traces.sampler=always_on \
  -jar target/spring-sample-1.0.0.jar
```

## 엔드포인트
- GET /api/fast — 10~50ms
- GET /api/slow — 500~2000ms
- GET /api/error — 랜덤 에러 (30%)
- GET /api/db — DB 쿼리 시뮬레이션
