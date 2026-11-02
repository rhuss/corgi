//! Transcript files: default names, name resolution and the append-only
//! writer that keeps one blank line before each contribution.
import * as fs from "node:fs";
import * as path from "node:path";

/** `transcript-YYYY-MM-DDTHH-MM-SS.txt` in local time. */
export function defaultName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  return `transcript-${date}T${time}.txt`;
}

/** The file a typed name stands for: `~/` is the home folder, absolute names
 * are used as given, and relative names stay inside `folder`. */
export function resolve(name: string, folder: string, home: string): { path: string } | { error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: "name is empty" };
  if (trimmed.startsWith("~/")) return { path: path.join(home, trimmed.slice(2)) };
  if (path.isAbsolute(trimmed)) return { path: path.normalize(trimmed) };
  const joined = path.join(folder, trimmed);
  const inside = path.relative(folder, joined);
  if (inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside))
    return { error: "stays inside the transcript folder: remove .." };
  return { path: joined };
}

export function exists(file: string): boolean {
  return fs.existsSync(file);
}

/** An open transcript, appended to one passage per line and synced after each. */
export class TranscriptFile {
  private fd: number;
  /** The file has text; any byte counts, whitespace included. */
  private lines: boolean;
  /** The file's last line has no line break yet. */
  private needs_newline: boolean;
  /** The file already ends with a blank line. */
  private blank_tail: boolean;
  private constructor(fd: number, tail: string) {
    this.fd = fd;
    this.lines = tail.length > 0;
    this.needs_newline = tail.length > 0 && !tail.endsWith("\n");
    // A file from Windows ends its blank line in \r\n.
    this.blank_tail = /\n\r?\n$/.test(tail);
  }
  /** Opens `file` for appending (mode 0600), creating missing folders (0700).
   * Throws with the OS message when it cannot. */
  static open(file: string): TranscriptFile {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // "a+" so the tail can be read through the same descriptor.
    const fd = fs.openSync(file, "a+", 0o600);
    try {
      const size = fs.fstatSync(fd).size;
      const tail = Buffer.alloc(Math.min(3, size));
      if (tail.length) fs.readSync(fd, tail, 0, tail.length, size - tail.length);
      return new TranscriptFile(fd, tail.toString("latin1"));
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  /** Appends one passage; a passage that starts a contribution gets one blank
   * line before it, except at the start of the file. */
  write(text: string, starts_contribution: boolean): void {
    let out = "";
    if (this.needs_newline) out += "\n";
    if (this.lines && starts_contribution && !this.blank_tail) out += "\n";
    out += text + "\n";
    const bytes = Buffer.from(out, "utf8");
    for (let done = 0; done < bytes.length;) done += fs.writeSync(this.fd, bytes, done);
    fs.fsyncSync(this.fd);
    this.lines = true;
    this.needs_newline = false;
    this.blank_tail = false;
  }
  close(): void {
    if (this.fd < 0) return;
    const fd = this.fd;
    this.fd = -1;
    fs.closeSync(fd);
  }
}
