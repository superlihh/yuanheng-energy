import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;

public class PowerOptimizerServer {
    private static final HttpClient CLIENT = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private static final String PYTHON_URL = System.getenv().getOrDefault("PYTHON_SERVICE_URL", "http://127.0.0.1:8001");
    private static Path frontendRoot = Path.of("frontend").toAbsolutePath().normalize();

    public static void main(String[] args) throws Exception {
        if (args.length > 0) frontendRoot = Path.of(args[0]).toAbsolutePath().normalize();
        int port = Integer.parseInt(System.getenv().getOrDefault("JAVA_PORT", "8080"));
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0);
        server.createContext("/api/", PowerOptimizerServer::proxy);
        server.createContext("/", PowerOptimizerServer::staticFile);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.start();
        System.out.println("PowerPilot listening on http://127.0.0.1:" + port);
    }

    private static void proxy(HttpExchange exchange) throws IOException {
        String method = exchange.getRequestMethod();
        if (!method.equals("GET") && !method.equals("POST")) {
            respond(exchange, 405, "{\"message\":\"仅支持 GET 和 POST\"}", "application/json; charset=utf-8");
            return;
        }
        String path = exchange.getRequestURI().toString();
        if (path.equals("/api/health")) path = "/health";
        try {
            // Keep authentication at the public gateway as well as in the business service.
            // Fine-grained workspace roles and version transitions are checked by Python.
            // The ingest endpoint authenticates a device-scoped credential in Python;
            // it does not accept a workspace ID or expose business reads/control.
            boolean publicRoute = path.equals("/health") || path.equals("/api/auth/login") || path.equals("/api/auth/register")
                || (method.equals("POST") && path.equals("/api/gateway/telemetry"));
            String authorization = exchange.getRequestHeaders().getFirst("Authorization");
            String requestId = UUID.randomUUID().toString();
            exchange.getResponseHeaders().set("X-Request-Id", requestId);
            if (!publicRoute) {
                if (authorization == null || !authorization.startsWith("Bearer ")) {
                    respond(exchange, 401, "{\"message\":\"请先登录\"}", "application/json; charset=utf-8"); return;
                }
                HttpResponse<String> identity = CLIENT.send(HttpRequest.newBuilder(URI.create(PYTHON_URL + "/api/auth/me"))
                    .header("Authorization", authorization).timeout(Duration.ofSeconds(10)).GET().build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                if (identity.statusCode() != 200) {
                    respond(exchange, identity.statusCode(), identity.body(), "application/json; charset=utf-8"); return;
                }
            }
            byte[] requestBody = new byte[0];
            boolean streaming = false;
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(PYTHON_URL + path)).timeout(Duration.ofSeconds(65));
            builder.header("X-Request-Id", requestId);
            if (authorization != null) builder.header("Authorization", authorization);
            if (method.equals("POST")) {
                requestBody = exchange.getRequestBody().readNBytes(2_500_001);
                if (requestBody.length > 2_500_000) {
                    respond(exchange, 413, "{\"message\":\"文件过大，请分批导入\"}", "application/json; charset=utf-8");
                    return;
                }
                String bodyText = new String(requestBody, StandardCharsets.UTF_8);
                streaming = bodyText.matches("(?s).*\\\"stream\\\"\\s*:\\s*true.*");
                builder.header("Content-Type", "application/json; charset=utf-8").POST(HttpRequest.BodyPublishers.ofByteArray(requestBody));
            } else builder.GET();
            if (streaming) {
                HttpResponse<InputStream> response = CLIENT.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
                streamRespond(exchange, response.statusCode(), response.body(), response.headers().firstValue("Content-Type").orElse("text/event-stream; charset=utf-8"));
            } else {
                HttpResponse<String> response = CLIENT.send(builder.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
                respond(exchange, response.statusCode(), response.body(), response.headers().firstValue("Content-Type").orElse("application/json; charset=utf-8"));
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            respond(exchange, 503, "{\"message\":\"请求中断，请重试\"}", "application/json; charset=utf-8");
        } catch (IOException e) {
            respond(exchange, 503, "{\"message\":\"计算服务暂时不可用，请检查 Python 服务\"}", "application/json; charset=utf-8");
        }
    }

    private static void staticFile(HttpExchange exchange) throws IOException {
        if (!exchange.getRequestMethod().equals("GET")) {
            respond(exchange, 405, "Method not allowed", "text/plain"); return;
        }
        String requestPath = exchange.getRequestURI().getPath();
        if (requestPath.equals("/")) requestPath = "/index.html";
        Path target = frontendRoot.resolve(requestPath.substring(1)).normalize();
        if (!target.startsWith(frontendRoot) || !Files.isRegularFile(target)) {
            respond(exchange, 404, "Not found", "text/plain; charset=utf-8"); return;
        }
        String name = target.getFileName().toString();
        String extension = name.contains(".") ? name.substring(name.lastIndexOf('.')) : "";
        String type = Map.of(".html", "text/html; charset=utf-8", ".css", "text/css; charset=utf-8", ".js", "text/javascript; charset=utf-8").getOrDefault(extension, "text/plain; charset=utf-8");
        respond(exchange, 200, Files.readString(target, StandardCharsets.UTF_8), type);
    }

    private static void respond(HttpExchange exchange, int status, String body, String type) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.getResponseHeaders().set("Referrer-Policy", "same-origin");
        exchange.getResponseHeaders().set("X-Frame-Options", "DENY");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var out = exchange.getResponseBody()) { out.write(bytes); }
    }

    private static void streamRespond(HttpExchange exchange, int status, InputStream body, String type) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", type);
        exchange.getResponseHeaders().set("Cache-Control", "no-cache, no-store");
        exchange.getResponseHeaders().set("X-Content-Type-Options", "nosniff");
        exchange.getResponseHeaders().set("X-Frame-Options", "DENY");
        exchange.sendResponseHeaders(status, 0);
        try (InputStream in = body; var out = exchange.getResponseBody()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                out.flush();
            }
        }
    }
}
