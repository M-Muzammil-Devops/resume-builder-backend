// Preloaded by the systemd unit (node --require ...): the API listens on host "0.0.0.0"; on the staging
// host it must only be reachable through the host nginx, so wildcard listen addresses are rewritten to
// LISTEN_HOST (default 127.0.0.1). Application code is unchanged.
"use strict";
const net = require("net");

const target = process.env.LISTEN_HOST || "127.0.0.1";
const WILDCARD = new Set(["", "0.0.0.0", "::"]);
const isWildcard = (h) => h === undefined || h === null || WILDCARD.has(h);
const origListen = net.Server.prototype.listen;

net.Server.prototype.listen = function patchedListen(...args) {
  const first = args[0];
  if (first && typeof first === "object" && !Array.isArray(first) && "port" in first && !first.path) {
    // listen({ port, host, ... }[, cb])  (what Fastify uses)
    if (isWildcard(first.host)) args[0] = { ...first, host: target };
  } else if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    // listen(port[, host][, backlog][, cb])
    if (typeof args[1] === "string") {
      if (isWildcard(args[1])) args[1] = target;
    } else {
      args.splice(1, 0, target);
    }
  }
  return origListen.apply(this, args);
};