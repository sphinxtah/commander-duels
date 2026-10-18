package com.commanderduels;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

public final class EngineServerTest {
    public static void main(String[] args) throws Exception {
        var server = EngineServer.create(0);
        server.start();
        try (var client = HttpClient.newHttpClient()) {
            String base = "http://localhost:" + server.getAddress().getPort();
            var health = client.send(HttpRequest.newBuilder(URI.create(base + "/health")).build(),
                HttpResponse.BodyHandlers.ofString());
            if (health.statusCode() != 200 || !health.body().equals(EngineServer.STATUS)) {
                throw new AssertionError("Health contract mismatch");
            }
            for (String path : new String[]{"/ready", "/v1/create_game", "/v1/submit_choice"}) {
                var response = client.send(HttpRequest.newBuilder(URI.create(base + path)).build(),
                    HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() != 503 || !response.body().contains("engine_not_integrated")) {
                    throw new AssertionError("Unimplemented gameplay must fail closed: " + path);
                }
            }
            System.out.println("Engine boundary tests passed");
        } finally { server.stop(0); }
        // The standalone smoke runner owns the virtual-thread executor lifecycle.
        System.exit(0);
    }
}
