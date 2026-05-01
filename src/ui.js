import { stdout as output } from "node:process";

export class Spinner {
  constructor(text, options = {}) {
    this.text = text;
    this.detail = options.detail || (() => "");
    this.frames = ["-", "\\", "|", "/"];
    this.index = 0;
    this.timer = null;
    this.enabled = Boolean(output.isTTY);
    this.lastLength = 0;
    this.startedAt = 0;
  }

  start() {
    this.startedAt = Date.now();
    if (!this.enabled) {
      const detail = this.detail(this);
      console.log(`[wait] ${this.text}${detail ? ` - ${detail}` : ""}`);
      return;
    }

    this.render(this.frames[0]);
    this.timer = setInterval(() => {
      const frame = this.frames[this.index % this.frames.length];
      this.index += 1;
      this.render(frame);
    }, 100);
  }

  stop(status = "ok", detail = "") {
    if (this.timer) clearInterval(this.timer);
    const message = `[${status}] ${this.text}${detail ? ` - ${detail}` : ""}`;

    if (!this.enabled) {
      console.log(message);
      return;
    }

    output.write(`\r${message}${" ".repeat(Math.max(0, this.lastLength - message.length))}\n`);
  }

  render(frame) {
    const detail = this.detail(this);
    const message = `${frame} ${this.text}${detail ? ` - ${detail}` : ""}`;
    output.write(`\r${message}${" ".repeat(Math.max(0, this.lastLength - message.length))}`);
    this.lastLength = message.length;
  }

  elapsedSeconds() {
    if (!this.startedAt) return 0;
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }
}

export async function withSpinner(text, action) {
  const spinner = new Spinner(text);
  spinner.start();
  try {
    const result = await action();
    spinner.stop("ok");
    return result;
  } catch (error) {
    spinner.stop("fail", error.message);
    throw error;
  }
}
