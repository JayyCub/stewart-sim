/**
 * Serial link to firmware/servo_test over Web Serial: the browser twin of scripts/rig_serial.py.
 * One command line out, one reply line back ("OK ..." or "ERR ..."). See the protocol at the
 * top of firmware/servo_test/servo_test.ino.
 */

/** The part of the Web Serial SerialPort this link uses (lets tests pass a fake). */
export interface PortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  setSignals(signals: { dataTerminalReady?: boolean }): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
}

export const BAUD = 115200;
export const FIRMWARE_READY = "READY servo_test v3";
/** Firmware frame queue: QUEUE_LEN and FRAME_US in servo_test.ino. */
export const QUEUE_LEN = 48;
export const FRAME_MS = 20;
/** Arduino LLC, Arduino SRL, CH340 clones (same list as rig_serial.py). */
export const ARDUINO_VENDOR_IDS = [0x2341, 0x2a03, 0x1a86];

const BOOT_TIMEOUT_MS = 5000;
const REPLY_TIMEOUT_MS = 1000;

export class LinkError extends Error {}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Link {
  /** Called once if the port stops delivering data (unplugged, closed, read error). */
  onLost: ((why: string) => void) | null = null;

  private lines: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly enc = new TextEncoder();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly port: PortLike;

  private constructor(port: PortLike) {
    this.port = port;
    if (!port.readable || !port.writable) throw new LinkError("Serial port is not readable and writable.");
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    void this.pump();
  }

  /** Open the port, reset the Uno (DTR pulse) and wait for the servo_test v3 READY line. */
  static async open(port: PortLike, sleep: (ms: number) => Promise<void> = realSleep): Promise<Link> {
    await port.open({ baudRate: BAUD });
    const link = new Link(port);
    try {
      // Opening the port does not reliably reset the Uno, so pulse DTR for a fresh READY line.
      await port.setSignals({ dataTerminalReady: false });
      await sleep(100);
      link.lines.length = 0;
      await port.setSignals({ dataTerminalReady: true });
      let line: string | null;
      do line = await link.nextLine(BOOT_TIMEOUT_MS);
      while (line !== null && !line.startsWith("READY"));
      if (line === null) throw new LinkError("No READY from the Uno. Is firmware/servo_test flashed, and is the serial monitor closed?");
      if (line.includes("ERR")) throw new LinkError(line);
      if (!line.startsWith(FIRMWARE_READY))
        throw new LinkError(`Unexpected firmware (${line}); live control needs ${FIRMWARE_READY}. Re-flash firmware/servo_test.`);
      return link;
    } catch (e) {
      await link.close();
      throw e;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private async pump(): Promise<void> {
    const dec = new TextDecoder();
    let buf = "";
    let why = "The Uno's serial port closed.";
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "").trim();
          buf = buf.slice(nl + 1);
          if (this.waiter) {
            const w = this.waiter;
            this.waiter = null;
            w(line);
          } else this.lines.push(line);
        }
      }
    } catch (e) {
      why = `Lost the Uno: ${(e as Error).message}`;
    }
    const wasOpen = !this.closed;
    this.closed = true;
    this.waiter?.(null);
    this.waiter = null;
    if (wasOpen) this.onLost?.(why);
  }

  private nextLine(timeoutMs: number): Promise<string | null> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = (line) => {
        clearTimeout(t);
        resolve(line);
      };
    });
  }

  /**
   * Send one command line and return its OK reply; throws LinkError on ERR, timeout or a closed
   * link. Commands are queued, so they reach the Uno in the order they were called.
   */
  command(cmd: string): Promise<string> {
    const p = this.chain.then(() => this.exchange(cmd));
    this.chain = p.catch(() => undefined);
    return p;
  }

  private async exchange(cmd: string): Promise<string> {
    if (this.closed) throw new LinkError("Not connected to the Uno.");
    this.lines.length = 0; // a late reply to an earlier command must not answer this one
    await this.writer.write(this.enc.encode(cmd + "\n"));
    const reply = await this.nextLine(REPLY_TIMEOUT_MS);
    if (reply === null) throw new LinkError(this.closed ? "Lost the Uno." : `No reply from the Uno to '${cmd}'.`);
    if (!reply.startsWith("OK")) throw new LinkError(reply);
    return reply;
  }

  /** Set all six channels now (refused by the Uno while queued frames are playing). */
  async setAll(usByChannel: readonly number[]): Promise<void> {
    await this.command("A " + usByChannel.join(" "));
  }

  /** Append a frame to the Uno's 50 Hz queue. Resolves to [frames queued, underruns]. */
  async queueFrame(usByChannel: readonly number[]): Promise<[number, number]> {
    const [, , q, u] = (await this.command("Q " + usByChannel.join(" "))).split(" ");
    return [Number(q), Number(u)];
  }

  /** No more frames coming: the Uno plays out its queue, then holds. */
  async endStream(): Promise<void> {
    await this.command("E");
  }

  /** Drop queued frames; the servos hold the frame playing now. Resolves to frames dropped. */
  async flush(): Promise<number> {
    return Number((await this.command("F")).split(" ")[2]);
  }

  /** Turn one channel off: that servo goes limp. */
  async off(channel: number): Promise<void> {
    await this.command(`O ${channel}`);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.waiter?.(null);
    this.waiter = null;
    try {
      await this.reader.cancel();
    } catch { /* already gone */ }
    try {
      this.reader.releaseLock();
      this.writer.releaseLock();
    } catch { /* already released */ }
    try {
      await this.port.close();
    } catch { /* unplugged */ }
  }
}
