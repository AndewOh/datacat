.PHONY: up down logs dev-db dev clean bench-ingest bench-xview load-gen

up:
	cd deploy && docker compose up -d

down:
	cd deploy && docker compose down

logs:
	cd deploy && docker compose logs -f

dev-db:
	cd deploy && docker compose up -d clickhouse redpanda redpanda-init

clean:
	cd deploy && docker compose down -v

ch-shell:
	docker exec -it datacat-clickhouse-1 clickhouse-client \
		--user datacat --password datacat_dev --database datacat

rp-shell:
	docker exec -it datacat-redpanda-1 rpk topic list --brokers localhost:9092

bench-ingest:
	chmod +x tools/bench/bench_ingest.sh
	tools/bench/bench_ingest.sh $(ENDPOINT) $(RATE) $(DURATION)

bench-xview:
	chmod +x tools/bench/bench_xview.sh
	tools/bench/bench_xview.sh $(API_URL)

load-gen:
	pip3 install -r tools/load-generator/requirements.txt -q
	python3 tools/load-generator/generate.py \
		--rate $(or $(RATE),1000) \
		--duration $(or $(DURATION),60) \
		--endpoint $(or $(ENDPOINT),localhost:4317)
