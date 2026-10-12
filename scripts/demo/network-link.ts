import { createConnection, createServer, type Socket } from "node:net";

// Faults affect only managed demonstration processes, never the real containers.
export class NetworkLink {
  private readonly sockets = new Set<Socket>();
  private readonly server = createServer((incoming) => {
    if (!this.connected) { incoming.destroy(); return; }
    const outgoing = createConnection({ host: "127.0.0.1", port: this.targetPort });
    for (const socket of [incoming, outgoing]) {
      socket.setNoDelay(true);
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => { incoming.destroy(); outgoing.destroy(); });
    }
    incoming.pipe(outgoing).pipe(incoming);
  });
  connected = true;
  port = 0;

  constructor(private readonly targetPort: 55434 | 4568) {}

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.off("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a local demonstration port");
    this.port = address.port;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) for (const socket of this.sockets) socket.destroy();
  }

  async close(): Promise<void> {
    this.setConnected(false);
    if (this.server.listening) await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }
}
