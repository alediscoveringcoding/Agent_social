import { createServer } from "node:http";
import { logger } from "../logger.js";

export function startHealthServer(port = 8787) {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ts: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, "127.0.0.1", () => {
    logger.info("Health server listening", { port });
  });
}
