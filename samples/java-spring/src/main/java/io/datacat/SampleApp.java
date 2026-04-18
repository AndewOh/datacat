package io.datacat;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.web.bind.annotation.*;
import java.util.Random;
import java.util.Map;
import java.util.concurrent.TimeUnit;

@SpringBootApplication
@RestController
@RequestMapping("/api")
public class SampleApp {
    private final Random random = new Random();

    public static void main(String[] args) {
        SpringApplication.run(SampleApp.class, args);
    }

    @GetMapping("/fast")
    public Map<String, Object> fast() throws Exception {
        Thread.sleep(10 + random.nextInt(40));
        return Map.of("status", "ok", "latency", "fast");
    }

    @GetMapping("/slow")
    public Map<String, Object> slow() throws Exception {
        Thread.sleep(500 + random.nextInt(1500));
        return Map.of("status", "ok", "latency", "slow");
    }

    @GetMapping("/error")
    public Map<String, Object> error() {
        if (random.nextFloat() < 0.3f) {
            throw new RuntimeException("Simulated error for datacat demo");
        }
        return Map.of("status", "ok");
    }

    @GetMapping("/db")
    public Map<String, Object> db() throws Exception {
        // DB 쿼리 시뮬레이션
        Thread.sleep(5 + random.nextInt(95));
        return Map.of("status", "ok", "rows", random.nextInt(100));
    }
}
