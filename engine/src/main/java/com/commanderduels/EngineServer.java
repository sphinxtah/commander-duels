package com.commanderduels;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;

/** Infrastructure boundary only. No XMage code or gameplay implementation is bundled. */
public final class EngineServer {
    public static final String STATUS =
        "{\"status\":\"scaffold\",\"protocol_version\":1,\"gameplay_available\":false}";

    private EngineServer() {}

    public static HttpServer create(int port) throws IOException {
        var server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 16);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            if (path.equals("/health") && exchange.getRequestMethod().equals("GET")) {
                respond(exchange, 200, STATUS);
            } else if (path.equals("/ready")) {
                respond(exchange, 503, "{\"code\":\"engine_not_integrated\"}");
            } else if (path.startsWith("/v1/")) {
                respond(exchange, 503, "{\"code\":\"engine_not_integrated\",\"protocol_version\":1}");
            } else {
                respond(exchange, 404, "{\"code\":\"not_found\"}");
            }
        });
        return server;
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var stream = exchange.getResponseBody()) { stream.write(bytes); }
        exchange.close();
    }

    public static void main(String[] args) throws IOException {
        int port = Integer.parseInt(System.getenv().getOrDefault("CD_ENGINE_PORT", "8090"));
        var server = create(port);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(2)));
        server.start();
        System.out.println("Commander Duels engine boundary v0.0.1; gameplay unavailable");
    }
}
