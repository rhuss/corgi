//! Transcript recording: the passages Whisper hears while a recording runs go
//! to its file one line at a time, split into contributions by `Turns`. A
//! passage belongs to the recording that ran when its speech ended, so a
//! stopping recording still takes its own passages after a new one starts.
import { TranscriptFile } from "./transcript";
import { Turns, speakerDash } from "./turns";
import type { Tuning } from "./tuning";
import type { Utterance } from "./session";

export type RecordingState = "running" | "paused" | "stopping" | "closed";
export type Recording = {
  /** The resolved file path. */
  path: string;
  state: RecordingState;
  started_at: number;
  /** Contribution breaks, and the contributions the reading view shows. */
  turns: Turns;
  /** Passages claimed by this recording, not yet written or given up. */
  pending: Set<Utterance>;
  /** Called once `pending` empties, by a stop waiting for it. */
  drained: (() => void)[];
  file: TranscriptFile;
  /** Once stopping: when it stopped, and what settles when the file is closed,
   * with the passages left out. */
  stopped_at: number;
  done: Promise<{ path: string; late: number }> | null;
  late: number;
};
export type Notice = { at: number; kind: "info" | "error"; text: string };

/** How many notices the history keeps. */
const max_notices = 200;

/** The OS message of a file error, without the stack. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Recorder {
  /** The recording that is running or paused. */
  current: Recording | null = null;
  /** Stopped recordings still waiting for their passages. */
  stopping = new Set<Recording>();
  /** Why the last recording could not start or stopped writing. */
  error: string | null = null;
  notices: Notice[] = [];
  private listeners: (() => void)[] = [];
  constructor(private deps: { tuning: Tuning; now: () => number; log?: (line: string) => void }) {}
  on(_event: "change", fn: () => void): void {
    this.listeners.push(fn);
  }
  private changed(): void {
    for (const fn of this.listeners) fn();
  }
  private notice(kind: Notice["kind"], text: string): void {
    this.notices.push({ at: this.deps.now(), kind, text });
    if (this.notices.length > max_notices) this.notices.splice(0, this.notices.length - max_notices);
  }
  /** Opens `path` for appending and starts recording into it; an open error
   * changes nothing and is returned. */
  start(path: string): { path: string } | { error: string } {
    if (this.current) return this.refuse(path, "a recording is already running");
    // Two writers on one file would get its blank lines wrong.
    for (const r of this.stopping)
      if (r.path === path) return this.refuse(path, "this file is still being finished; try again in a moment");
    let file: TranscriptFile;
    try {
      file = TranscriptFile.open(path);
    } catch (error) {
      return this.refuse(path, message(error));
    }
    const turns = new Turns(this.deps.tuning.pause_break);
    turns.reset();
    this.current = {
      path,
      state: "running",
      started_at: this.deps.now(),
      turns,
      pending: new Set(),
      drained: [],
      file,
      stopped_at: 0,
      done: null,
      late: 0,
    };
    this.error = null;
    this.deps.tuning.begin();
    this.deps.log?.(`recording: started ${path}`);
    this.notice("info", `recording started: ${path}`);
    this.changed();
    return { path };
  }
  private refuse(path: string, why: string): { error: string } {
    this.error = why;
    this.deps.log?.(`recording: cannot start ${path}: ${why}`);
    this.notice("error", `recording not started: ${why}`);
    this.changed();
    return { error: why };
  }
  pause(): void {
    const r = this.current;
    if (r?.state !== "running") return;
    r.state = "paused";
    this.deps.log?.(`recording: paused ${r.path}`);
    this.notice("info", "paused");
    this.changed();
  }
  /** Back into the same file; the next written passage starts a contribution. */
  resume(): void {
    const r = this.current;
    if (r?.state !== "paused") return;
    r.state = "running";
    r.turns.reset();
    this.deps.log?.(`recording: resumed ${r.path}`);
    this.notice("info", "resumed");
    this.changed();
  }
  /** Stops the current recording at once and closes its file once its pending
   * passages are written, or after `timeoutMs`; `late` counts those left out.
   * Null when nothing was recording. */
  stop(timeoutMs = 10_000): Promise<{ path: string; late: number }> | null {
    const r = this.current;
    if (!r) return null;
    r.state = "stopping";
    r.stopped_at = this.deps.now();
    this.current = null;
    this.stopping.add(r);
    this.deps.tuning.end();
    this.changed();
    r.done = this.close(r, timeoutMs);
    return r.done;
  }
  private async close(r: Recording, timeoutMs: number): Promise<{ path: string; late: number }> {
    if (r.pending.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>(resolve => {
        r.drained.push(resolve);
        timer = setTimeout(resolve, timeoutMs);
      });
      clearTimeout(timer);
    }
    // Quitting may have closed it meanwhile.
    return this.stopping.has(r) ? this.closed(r) : { path: r.path, late: r.late };
  }
  /** Closes `r` now, counting what it still waits for as late. */
  private closed(r: Recording): { path: string; late: number } {
    const late = (r.late = r.pending.size),
      waited = this.deps.now() - r.stopped_at,
      // A write error may have closed it already; that was reported then.
      failed = r.state === "closed";
    r.pending.clear();
    this.stopping.delete(r);
    r.state = "closed";
    this.deps.log?.(`recording: stopped ${r.path} waited_ms=${Math.round(waited)} late=${late}`);
    if (!failed) {
      try {
        r.file.close();
        this.notice("info", `stopped: ${r.path}`);
      } catch (error) {
        // What was written is synced already; the close itself failed.
        const why = message(error);
        this.error = why;
        this.deps.log?.(`recording: close failed ${r.path}: ${why}`);
        this.notice("error", `recording stopped: ${why}`);
      }
      if (late) this.notice("error", `${late} passage${late === 1 ? "" : "s"} did not finish in time`);
    }
    this.changed();
    return { path: r.path, late };
  }
  /** Quitting without waiting any longer: stops the current recording and
   * closes every stopping one at once, with what each still waited for. */
  finish(): { path: string; late: number }[] {
    void this.stop();
    return [...this.stopping].map(r => {
      const result = this.closed(r);
      // Their waits end too; they find the file closed.
      for (const fn of r.drained.splice(0)) fn();
      return result;
    });
  }
  /** Assigns `u`, whose speech just ended, to the running recording, if any. */
  claim(u: Utterance): void {
    const r = this.current;
    if (r?.state !== "running") return;
    u.record = r;
    r.pending.add(u);
  }
  /** Writes `u`'s cleaned `text` to its recording; false when nothing was
   * written (only a speaker dash, or the recording is closed). */
  write(u: Utterance, text: string): boolean {
    const r = u.record;
    if (!r || !r.pending.has(u)) return false;
    r.pending.delete(u);
    const said = speakerDash(text);
    let written = false;
    if (said.text) {
      const starts = r.turns.next({
        text: said.text,
        speech_start: u.speech_start,
        speech_end: u.speech_end,
        capped: u.capped,
        continues: u.continues,
        dash: said.dash,
      });
      try {
        r.file.write(said.text, starts);
        written = true;
      } catch (error) {
        // The reading view mirrors the file: the passage leaves it again.
        const last = r.turns.contributions.at(-1)!;
        last.texts.pop();
        if (!last.texts.length) r.turns.contributions.pop();
        this.failed(r, error);
      }
    }
    this.settle(r);
    this.changed();
    return written;
  }
  /** `u` ends without text for its recording. */
  release(u: Utterance): void {
    const r = u.record;
    if (r?.pending.delete(u)) this.settle(r);
  }
  private settle(r: Recording): void {
    if (r.pending.size) return;
    for (const fn of r.drained.splice(0)) fn();
  }
  /** A write failed: the recording closes, and dictation goes on. */
  private failed(r: Recording, error: unknown): void {
    const why = message(error);
    r.state = "closed";
    try {
      r.file.close();
    } catch {}
    r.pending.clear();
    this.settle(r);
    if (this.current === r) {
      this.current = null;
      this.deps.tuning.end();
    }
    this.error = why;
    this.deps.log?.(`recording: write failed ${r.path}: ${why}`);
    this.notice("error", `recording stopped: ${why}`);
  }
}
