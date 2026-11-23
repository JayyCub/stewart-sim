import { FRAME_MS, QUEUE_LEN, type PortLike } from "../src/hardware/link.ts";

/**
 * Software stand-in for firmware/servo_test v3 on a virtual clock: same commands, replies,
 * 500-2500 us window and 48-frame queue played every 20 ms. Records every pulse frame that
 * reached the "servos", so tests can check speed and limits frame by frame.
 */
export class FakeUno implements PortLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  now = 0;
  /** Frames written to the servos, in order. */
  output: number[][] = [];
  commands: string[] = [];
  failOn: string | null = null;
  firmware = "READY servo_test v3";
  private out!: ReadableStreamDefaultController<Uint8Array>;
  private queue: number[][] = [];
  private nextDue = 0;
  private playing = false;
  private streaming = false;
  private underruns = 0;
  private played = 0;

  constructor() {
    this.readable = new ReadableStream({ start: (c) => void (this.out = c) });
    const dec = new TextDecoder();
    let buf = "";
    this.writable = new WritableStream({
      write: (chunk) => {
        buf += dec.decode(chunk);
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          this.handle(line);
        }
      },
    });
  }

  async open() {}
  async close() {}
  async setSignals(s: { dataTerminalReady?: boolean }) {
    if (s.dataTerminalReady) this.say(this.firmware);
  }

  private say(line: string) {
    this.out.enqueue(new TextEncoder().encode(line + "\r\n"));
  }

  /** Play queued frames that fell due on the virtual clock. */
  advance() {
    while (this.playing && this.nextDue <= this.now) {
      if (this.queue.length) {
        this.output.push(this.queue.shift()!);
        this.played++;
      } else if (this.streaming) this.underruns++;
      else this.playing = false;
      this.nextDue += FRAME_MS;
    }
  }

  get holding(): number[] | undefined {
    return this.output[this.output.length - 1];
  }

  private handle(cmd: string) {
    this.advance();
    this.commands.push(cmd);
    if (this.failOn && cmd.startsWith(this.failOn)) return this.say("ERR I2C timeout talking to PCA9685");
    const [op, ...rest] = cmd.split(" ");
    const v = rest.map(Number);
    const okPulses = () => v.every((u) => u >= 500 && u <= 2500);
    if (op === "Q" && v.length === 6) {
      if (this.queue.length >= QUEUE_LEN) return this.say("ERR queue full");
      if (!okPulses()) return this.say("ERR pulse outside 500-2500 us");
      if (!this.streaming) this.underruns = this.played = 0;
      this.queue.push(v);
      this.streaming = true;
      if (!this.playing) {
        this.playing = true;
        this.nextDue = this.now;
        this.advance();
      }
      return this.say(`OK Q ${this.queue.length} ${this.underruns}`);
    }
    if (op === "?") return this.say(`OK ? ${this.queue.length} ${this.underruns} ${this.played}`);
    if (op === "E") {
      this.streaming = false;
      return this.say("OK E");
    }
    if (op === "F") {
      const n = this.queue.length;
      this.queue = [];
      this.streaming = false;
      return this.say(`OK F ${n}`);
    }
    if ((op === "A" || op === "O" || op === "S") && this.queue.length) return this.say("ERR queue playing; send F first");
    if (op === "A" && v.length === 6) {
      if (!okPulses()) return this.say("ERR pulse outside 500-2500 us");
      this.output.push(v);
      return this.say("OK A");
    }
    if (op === "O" && v.length === 1) return this.say(`OK O ${v[0]}`);
    this.say(`ERR bad command: ${cmd}`);
  }
}
