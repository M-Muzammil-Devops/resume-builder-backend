/**
 * Loopback TCP forwarder for PDF export (started by backend-entrypoint.sh).
 *
 * Puppeteer opens PRINT_BASE_URL/print/:id. The app's CSP contains "upgrade-insecure-requests", so
 * Chromium would rewrite http://frontend:3000/... sub-resources to https:// and the page never loads.
 * Loopback origins (127.0.0.1) are not upgraded, so the backend container listens on
 * 127.0.0.1:PRINT_PROXY_PORT and pipes every connection to PRINT_PROXY_TARGET (frontend:3000) on the
 * compose network. Not reachable from outside the container.
 */
"use strict";
const net = require("node:net");

const target = process.env.PRINT_PROXY_TARGET || "frontend:3000";
const idx = target.lastIndexOf(":");
const host = target.slice(0, idx);
const port = Number(target.slice(idx + 1));
const listenPort = Number(process.env.PRINT_PROXY_PORT || 3000);

const server = net.createServer((client) => {
  const upstream = net.connect(port, host);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
  client.on("close", close);
  upstream.on("close", close);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on("error", (err) => {
  console.error(JSON.stringify({ level: "error", msg: "print-proxy failed", err: String(err) }));
  process.exit(1);
});
server.listen(listenPort, "127.0.0.1", () => {
  console.log(JSON.stringify({ level: "info", msg: `print-proxy 127.0.0.1:${listenPort} -> ${target}` }));
});
