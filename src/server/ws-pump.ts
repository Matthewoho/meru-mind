import crypto from "node:crypto";
import type http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { DbPort } from "../ports.js";
import type { Principal } from "../types.js";
import { ChangeWakeBus, MindPump } from "./pump.js";
import { isPrincipalTokenActive } from "./tokens.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_CLIENT_PAYLOAD_BYTES = 4096; // Hard Condition #3: downlink-only, maxPayload = 4KB
const PING_INTERVAL_MS = 25_000; // Hard Condition #5: 25s ping
const INACTIVITY_TIMEOUT_MS = 60_000; // Hard Condition #5: 60s timeout

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendClose(socket: Duplex, code: number, reason = ""): void {
  if (socket.destroyed || !socket.writable) return;
  const reasonBuf = Buffer.from(reason, "utf8").subarray(0, 100);
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  try {
    socket.write(encodeWsFrame(0x8, payload));
    socket.end();
  } catch {
    socket.destroy();
  }
}

function rejectUpgrade(socket: Duplex, statusLine: string, message: string): void {
  if (socket.destroyed) return;
  try {
    socket.write(
      `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
    );
    socket.end();
  } catch {
    socket.destroy();
  }
}

export function isOriginAllowed(params: {
  originHeader: string | undefined;
  hostHeader: string | undefined;
  allowedOrigins?: string[];
}): boolean {
  const origin = params.originHeader?.trim();
  if (!origin) return false; // Hard Condition #2: strict Origin whitelist required on WS handshake
  if (params.allowedOrigins && params.allowedOrigins.length > 0) {
    return params.allowedOrigins.includes(origin);
  }
  if (!params.hostHeader) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === params.hostHeader.trim();
  } catch {
    return false;
  }
}

export interface AttachPumpWsOptions {
  httpServer: http.Server;
  db: DbPort;
  wakeBus: ChangeWakeBus;
  orgId: string;
  allowedOrigins?: string[];
  authenticateCookie: (req: IncomingMessage) => Principal | null;
  /** Optional override for unit testing ping/timeout behavior */
  pingIntervalMs?: number;
  inactivityTimeoutMs?: number;
}

export interface PumpWsHandle {
  (): void;
  closeForActor(orgId: string, actorId: string): number;
}

/**
 * Attaches the Pump-backed WebSocket endpoint at `WS /v1/ws`, strictly enforcing ALL 7 Fable hard conditions:
 * 1. Same-origin HttpOnly Cookie auth (NEVER accepts tokens in URL query string)
 * 2. Strict Origin whitelist verification on Upgrade
 * 3. Downlink-only (client may only send `hello` / `pong`; maxPayload = 4096 bytes)
 * 4. Backpressure-safe batching (waits for socket.writableLength === 0 / drain before next SQLite batch)
 * 5. 25s ping + app-level heartbeat + 60s dead-peer disconnect
 * 6. Per-batch token validity & topologyVersion re-verification via MindPump
 * 7. Thin contentless frames only (content fetched via REST through policy.ts)
 */
export function attachPumpWebSocketServer(
  options: AttachPumpWsOptions,
): PumpWsHandle {
  const pingMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
  const timeoutMs = options.inactivityTimeoutMs ?? INACTIVITY_TIMEOUT_MS;
  const activeSockets = new Map<
    Duplex,
    { orgId: string; actorId: string; cleanup: () => void }
  >();

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      rejectUpgrade(socket, "400 Bad Request", "Malformed URL");
      return;
    }

    if (url.pathname !== "/v1/ws") {
      rejectUpgrade(socket, "404 Not Found", "WebSocket route not found");
      return;
    }

    // Hard Condition #1: NEVER accept long-lived tokens in URL query strings
    if (
      url.searchParams.has("token") ||
      url.searchParams.has("access_token") ||
      url.searchParams.has("api_key")
    ) {
      rejectUpgrade(
        socket,
        "400 Bad Request",
        "Tokens are forbidden in WebSocket URLs; authenticate with HttpOnly Cookie.",
      );
      return;
    }

    // Hard Condition #2: Strict Origin check
    if (
      !isOriginAllowed({
        originHeader: req.headers.origin,
        hostHeader: req.headers.host,
        allowedOrigins: options.allowedOrigins,
      })
    ) {
      rejectUpgrade(socket, "403 Forbidden", "Origin not allowed");
      return;
    }

    // Hard Condition #1: Cookie authentication
    const principal = options.authenticateCookie(req);
    if (!principal) {
      rejectUpgrade(socket, "401 Unauthorized", "Missing or invalid session cookie");
      return;
    }

    const wsKey = req.headers["sec-websocket-key"];
    if (!wsKey || typeof wsKey !== "string") {
      rejectUpgrade(socket, "400 Bad Request", "Missing Sec-WebSocket-Key");
      return;
    }

    const acceptKey = crypto
      .createHash("sha1")
      .update(`${wsKey.trim()}${WS_GUID}`, "utf8")
      .digest("base64");

    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "\r\n",
      ].join("\r\n"),
    );

    const pump = new MindPump(options.db, options.wakeBus, principal);
    let cursorSeq = 0;
    let clientGen: number | undefined;
    let helloReceived = false;
    let pumping = false;
    let wakePending = false;
    let unsubBus: (() => void) | null = null;
    let subscribedTopoVer = -1;
    let lastClientActivityMs = Date.now();
    let recvBuf: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      activeSockets.delete(socket);
      clearInterval(pingTimer);
      if (unsubBus) {
        unsubBus();
        unsubBus = null;
      }
    };

    activeSockets.set(socket, {
      orgId: principal.orgId,
      actorId: principal.actor.id,
      cleanup,
    });

    const sendJsonFrame = (obj: unknown): Promise<void> => {
      if (closed || socket.destroyed || !socket.writable) {
        return Promise.resolve();
      }
      const frame = encodeWsFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8"));
      return new Promise<void>((resolve) => {
        const flushed = socket.write(frame, () => {
          // Hard Condition #4: only proceed once kernel write buffer drains to 0
          if (socket.writableLength === 0) {
            resolve();
          } else {
            socket.once("drain", () => resolve());
          }
        });
        if (!flushed) {
          socket.once("drain", () => resolve());
        }
      });
    };

    const ensureBusSubscription = () => {
      const currentTopoVer = options.db.getTopologyVersion();
      if (unsubBus && subscribedTopoVer === currentTopoVer) return;
      if (unsubBus) {
        unsubBus();
        unsubBus = null;
      }
      const visibleRealms = pump.getVisibleRealmIds(false);
      subscribedTopoVer = currentTopoVer;
      unsubBus = options.wakeBus.subscribe(principal.orgId, visibleRealms, () => {
        scheduleDrain();
      });
    };

    const drainLoop = async () => {
      if (closed || !helloReceived || pumping) {
        if (pumping) wakePending = true;
        return;
      }
      pumping = true;
      try {
        do {
          wakePending = false;
          // Hard Condition #6: Verify token active before EVERY batch
          if (!isPrincipalTokenActive(options.db, principal)) {
            sendClose(socket, 4001, "Token revoked");
            cleanup();
            return;
          }
          ensureBusSubscription();
          const batch = pump.readBatch({
            sinceSeq: cursorSeq,
            generation: clientGen,
            limit: 50,
          });
          if (batch.resetRequired) {
            clientGen = batch.generation;
            cursorSeq = batch.latestSeq;
            await sendJsonFrame({
              type: "reset",
              generation: batch.generation,
              latestSeq: batch.latestSeq,
              topologyVersion: batch.topologyVersion,
            });
            return;
          }
          clientGen = batch.generation;
          if (batch.frames.length > 0) {
            cursorSeq = batch.frames[batch.frames.length - 1]!.seq;
            await sendJsonFrame({
              type: "frames",
              generation: batch.generation,
              topologyVersion: batch.topologyVersion,
              latestSeq: batch.latestSeq,
              frames: batch.frames,
            });
            if (batch.frames.length >= 50) {
              wakePending = true;
            }
          }
        } while (wakePending && !closed);
      } catch {
        sendClose(socket, 1011, "Pump error");
        cleanup();
      } finally {
        pumping = false;
      }
    };

    const scheduleDrain = () => {
      if (!helloReceived || closed) return;
      void drainLoop();
    };

    const handleClientMessage = (rawText: string) => {
      lastClientActivityMs = Date.now();
      let msg: unknown;
      try {
        msg = JSON.parse(rawText);
      } catch {
        sendClose(socket, 1003, "Invalid JSON");
        cleanup();
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
        sendClose(socket, 1008, "Invalid frame object");
        cleanup();
        return;
      }
      const obj = msg as Record<string, unknown>;
      if (obj.type === "pong") {
        return;
      }
      if (obj.type === "hello") {
        if (typeof obj.sinceSeq === "number" && Number.isFinite(obj.sinceSeq)) {
          cursorSeq = Math.max(0, Math.floor(obj.sinceSeq));
        }
        if (
          typeof obj.generation === "number" &&
          Number.isFinite(obj.generation)
        ) {
          clientGen = Math.floor(obj.generation);
        }
        helloReceived = true;
        void sendJsonFrame({
          type: "welcome",
          generation: options.db.getChangeLogGeneration(),
          topologyVersion: options.db.getTopologyVersion(),
          cursorSeq,
        }).then(() => scheduleDrain());
        return;
      }
      // Hard Condition #3: Downlink-only — reject any write/unknown client commands
      sendClose(
        socket,
        1008,
        "WebSocket is downlink-only; use REST /v1/* for writes",
      );
      cleanup();
    };

    const processRecvBuffer = () => {
      while (recvBuf.length >= 2 && !closed) {
        const b0 = recvBuf[0]!;
        const b1 = recvBuf[1]!;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let payloadLen = b1 & 0x7f;
        let offset = 2;

        if (!masked) {
          sendClose(socket, 1002, "Client frames must be masked");
          cleanup();
          return;
        }
        if (payloadLen === 126) {
          if (recvBuf.length < 4) return;
          payloadLen = recvBuf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          sendClose(socket, 1009, "Payload exceeds 4KB limit");
          cleanup();
          return;
        }

        // Hard Condition #3: Enforce maxPayload = 4096 bytes strictly before reading payload
        if (payloadLen > MAX_CLIENT_PAYLOAD_BYTES) {
          sendClose(socket, 1009, "Payload exceeds 4KB limit");
          cleanup();
          return;
        }

        const totalFrameLen = offset + 4 + payloadLen;
        if (recvBuf.length < totalFrameLen) return;

        const maskKey = recvBuf.subarray(offset, offset + 4);
        const maskedPayload = recvBuf.subarray(offset + 4, totalFrameLen);
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i += 1) {
          unmasked[i] = maskedPayload[i]! ^ maskKey[i % 4]!;
        }
        recvBuf = recvBuf.subarray(totalFrameLen);

        lastClientActivityMs = Date.now();

        if (opcode === 0x8) {
          sendClose(socket, 1000, "Normal closure");
          cleanup();
          return;
        }
        if (opcode === 0x9) {
          // Ping -> Pong
          socket.write(encodeWsFrame(0xa, unmasked));
          continue;
        }
        if (opcode === 0xa) {
          // Pong
          continue;
        }
        if (opcode === 0x1) {
          handleClientMessage(unmasked.toString("utf8"));
          continue;
        }
        sendClose(socket, 1003, "Unsupported opcode");
        cleanup();
        return;
      }
    };

    const pingTimer = setInterval(() => {
      if (closed || socket.destroyed) {
        cleanup();
        return;
      }
      if (Date.now() - lastClientActivityMs > timeoutMs) {
        sendClose(socket, 1001, "Heartbeat timeout");
        cleanup();
        return;
      }
      if (!isPrincipalTokenActive(options.db, principal)) {
        sendClose(socket, 4001, "Token revoked");
        cleanup();
        return;
      }
      try {
        socket.write(encodeWsFrame(0x9, Buffer.from("ping")));
        void sendJsonFrame({ type: "ping", ts: new Date().toISOString() });
      } catch {
        cleanup();
      }
    }, pingMs);
    pingTimer.unref?.();

    socket.on("data", (chunk: Buffer) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);
      processRecvBuffer();
    });
    socket.on("close", cleanup);
    socket.on("error", cleanup);

    if (recvBuf.length > 0) {
      processRecvBuffer();
    }
  };

  options.httpServer.on("upgrade", onUpgrade);

  const detach = (() => {
    options.httpServer.off("upgrade", onUpgrade);
    for (const [sock, entry] of activeSockets.entries()) {
      sendClose(sock, 1001, "Server shutting down");
      entry.cleanup();
    }
    activeSockets.clear();
  }) as PumpWsHandle;

  detach.closeForActor = (targetOrgId: string, actorId: string): number => {
    const targetLower = actorId.trim().toLowerCase();
    let closedCount = 0;
    for (const [sock, entry] of Array.from(activeSockets.entries())) {
      if (
        entry.orgId === targetOrgId &&
        entry.actorId.toLowerCase() === targetLower
      ) {
        sendClose(sock, 4001, "Actor disabled");
        entry.cleanup();
        closedCount += 1;
      }
    }
    return closedCount;
  };

  return detach;
}
