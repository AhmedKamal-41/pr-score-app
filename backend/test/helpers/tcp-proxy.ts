import net from 'node:net';

/**
 * A loopback TCP proxy that can simulate an outage of the upstream service:
 * `cut()` destroys open connections and refuses new ones; `restore()` resumes.
 */
export class ToggleProxy {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private up = true;
  port = 0;

  constructor(private readonly target: { host: string; port: number }) {}

  async start(): Promise<number> {
    this.server = net.createServer((client) => {
      if (!this.up) {
        client.destroy();
        return;
      }
      const upstream = net.connect(this.target.port, this.target.host);
      this.sockets.add(client).add(upstream);
      const drop = () => {
        client.destroy();
        upstream.destroy();
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.pipe(upstream).pipe(client);
      client.on('error', drop).on('close', drop);
      upstream.on('error', drop).on('close', drop);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server!.address() as net.AddressInfo).port;
    return this.port;
  }

  cut(): void {
    this.up = false;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  restore(): void {
    this.up = true;
  }

  async stop(): Promise<void> {
    this.cut();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}
