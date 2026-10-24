import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { LiveSocket, nativeSocket } from "../src/api/liveSocket";

function frame(opcode: number, payload: Buffer) {
  assert.ok(payload.length < 126);
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

test("native Node WebSocket receives JSON and handles actual auth-close 4401", async () => {
  const peers = new Set<import("node:stream").Duplex>();
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    peers.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => peers.delete(socket));
    const key = request.headers["sec-websocket-key"];
    assert.equal(typeof key, "string");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (request.url?.includes("expired")) {
      const code = Buffer.alloc(2);
      code.writeUInt16BE(4401);
      socket.end(frame(8, code));
    } else
      socket.write(frame(1, Buffer.from(JSON.stringify({ type: "session_list_update", payload: { sessions: [] } }))));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (const expired of [false, true]) {
      let finish: () => void = () => undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const statuses: string[] = [];
      let received = false;
      const socket = new LiveSocket(
        `ws://127.0.0.1:${address.port}/${expired ? "expired" : "valid"}`,
        "session_list_update",
        () => {
          received = true;
          finish();
        },
        (status) => {
          statuses.push(status);
          if (status === "auth-error") finish();
        },
        nativeSocket,
      );
      socket.start();
      try {
        await Promise.race([
          done,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("WebSocket integration timed out")), 2000);
            timer.unref();
          }),
        ]);
        assert.equal(received, !expired);
        assert.equal(statuses.at(-1), expired ? "auth-error" : "live");
      } finally {
        socket.stop();
      }
    }
  } finally {
    peers.forEach((peer) => peer.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
