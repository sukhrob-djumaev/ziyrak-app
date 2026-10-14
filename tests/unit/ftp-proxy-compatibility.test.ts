import { describe, it, expect } from "vitest";
import { createServer, type Socket, type Server } from "node:net";
import { once } from "node:events";
import { getUri } from "get-uri";
async function ftpFixture({
  fallback = false,
  separateHost = false,
}: { fallback?: boolean; separateHost?: boolean } = {}) {
  const sockets = new Set<Socket>(),
    servers: Server[] = [],
    commands: string[] = [];
  const content = "Synthetic proxy configuration";
  const control = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    const reply = (text: string) => socket.write(text + "\r\n");
    let buffered = "",
      pending = Promise.resolve(),
      data: Promise<Socket> | undefined;
    async function command(line: string) {
      const [verb, ...rest] = line.split(" "),
        arg = rest.join(" ");
      commands.push(verb);
      if (verb === "USER") return void reply("331 Password required");
      if (verb === "PASS") return void reply("230 Logged in");
      if (verb === "FEAT")
        return void reply(
          "211-Features\r\n UTF8\r\n MDTM\r\n MLST type*;size*;modify*;\r\n211 End"
        );
      if (verb === "MDTM")
        return void reply(
          arg.includes("missing")
            ? "550 File not found"
            : fallback
              ? "500 Unsupported"
              : "213 20260101000000"
        );
      if (verb === "SIZE") return void reply("213 " + Buffer.byteLength(content));
      if (verb === "EPSV" && separateHost) return void reply("500 EPSV unavailable");
      if (verb === "PASV" && separateHost)
        return void reply("227 Entering Passive Mode (192,0,2,1,0,1)");
      if (verb === "EPSV") {
        const listener = createServer();
        servers.push(listener);
        data = new Promise((resolve) =>
          listener.once("connection", (connection) => {
            sockets.add(connection);
            connection.on("error", () => {});
            connection.on("close", () => sockets.delete(connection));
            resolve(connection);
          })
        );
        listener.listen(0, "127.0.0.1");
        await once(listener, "listening");
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("Fixture address missing");
        reply("229 Entering Extended Passive Mode (|||" + address.port + "|)");
        return;
      }
      if (verb === "MLSD" || verb === "LIST" || verb === "RETR") {
        if (!data) throw new Error("Fixture passive data connection missing");
        reply("150 Data connection ready");
        const channel = await data;
        channel.end(
          verb === "MLSD"
            ? "type=file;size=29;modify=20260101000000; config.pac\r\n"
            : verb === "LIST"
              ? "-rw-r--r-- 1 fixture fixture 29 Jan 01 2026 config.pac\r\n"
              : content
        );
        await once(channel, "close");
        reply("226 Transfer complete");
        return;
      }
      if (verb === "QUIT") {
        reply("221 Goodbye");
        socket.end();
        return;
      }
      reply("200 OK");
    }
    socket.on("data", (bytes) => {
      buffered += bytes.toString();
      for (;;) {
        const end = buffered.indexOf("\r\n");
        if (end < 0) break;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        pending = pending
          .then(() => command(line))
          .catch(() => {
            reply("421 Fixture error");
            socket.destroy();
          });
      }
    });
    reply("220 Synthetic FTP fixture");
  });
  servers.push(control);
  control.listen(0, "127.0.0.1");
  await once(control, "listening");
  const address = control.address();
  if (!address || typeof address === "string") throw new Error("Fixture address missing");
  return {
    url: new URL("ftp://127.0.0.1:" + address.port + "/config.pac"),
    content,
    commands,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      );
    },
  };
}
describe("get-uri/basic-ftp consumed API compatibility (test-owned loopback FTP)", () => {
  it.each([false, true])(
    "downloads and caches a configuration with MDTM fallback=%s",
    async (fallback) => {
      const f = await ftpFixture({ fallback });
      try {
        const stream = await getUri(f.url, { timeout: 3000 });
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).toString()).toBe(f.content);
        expect(f.commands).toContain("MDTM");
        expect(f.commands).toContain("RETR");
        if (fallback)
          expect(f.commands.some((command) => command === "MLSD" || command === "LIST")).toBe(true);
        await expect(getUri(f.url, { cache: stream, timeout: 3000 })).rejects.toMatchObject({
          code: "ENOTMODIFIED",
        });
      } finally {
        await f.close();
      }
    }
  );
  it("preserves rejection of a different passive transfer host", async () => {
    const f = await ftpFixture({ fallback: true, separateHost: true });
    try {
      await expect(getUri(f.url, { timeout: 3000 })).rejects.toThrow(/PASV returned another host/);
      expect(f.commands).toContain("PASV");
    } finally {
      await f.close();
    }
  });
  it("closes cleanly when the configured file does not exist", async () => {
    const f = await ftpFixture();
    try {
      await expect(getUri(new URL("missing.pac", f.url), { timeout: 3000 })).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
});
