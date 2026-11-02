//! Voice mode's pipeline: microphone frames become utterances, Whisper's text
//! is cleaned and classified, and one delivery at a time goes to the runtime,
//! each given 2 s. Nothing waits for a lost link; it is retried every 5 s.
import * as wav from "./wav";
import * as text from "./text";
import * as level from "./level";
import * as errors from "../errors";
import { Failure } from "../failure";
import { bounded, type Seen, type VoiceLink } from "./link";
import type { Segmenter, Segment } from "./segmenter";
import type { Server } from "./whisper";
import type { MicProblem } from "./capture";
import type { Recorder, Recording } from "./recorder";

/** "muted": dropped by a mute, on purpose; "discarded": dropped for `reason`;
 * "recorded": written to a transcript but not typed, for `reason`. */
export type UtteranceStatus =
  "recording" | "transcribing" | "delivering" | "delivered" | "failed" | "muted" | "discarded" | "dropped" | "recorded";
export type Utterance = {
  id: number;
  captured_at: number;
  duration: number;
  status: UtteranceStatus;
  text: string | null;
  reason: string | null;
  timings: { transcribe_ms?: number; deliver_ms?: number };
  /** The transcript recording this passage goes to, decided when its speech ended. */
  record: Recording | null;
  /** Why it is no longer typed; null while it may still be. */
  untyped: Untyped | null;
  /** When its loud audio began and ended, whether the cap cut it, and whether
   * it carries on such a cut. */
  speech_start: number;
  speech_end: number;
  capped: boolean;
  continues: boolean;
};
/** Why a passage is not typed. */
export type Untyped = "muted" | "no_viewer" | "backlog";
/** What the history says for each, after "recorded, not typed" or "discarded". */
const untyped_reason: Record<Untyped, string> = {
  muted: "muted",
  no_viewer: "no viewer attached",
  backlog: "backlog",
};
export type LinkState = "connecting" | "connected" | "lost" | "refused" | "closed";
export type Unavailable = MicProblem | "server_down";

/** Why a delivery failed, as the history says it. */
export function reason(error: unknown): string {
  switch (errors.name(error)) {
    case "NoViewer":
      return "no viewer attached";
    case "NoFocusedPane":
      return "no focused pane";
    case "VoicePane":
      return "focused pane is the voice pane";
    case "Timeout":
      return "timed out";
    case "NotConnected":
    case "ConnectionClosed":
    case "NoRuntime":
    case "VoiceGone":
      return "not connected";
    case "ServerDown":
      return "server crashed";
    case "ServerRestarting":
      return "filter switching";
    default:
      return errors.name(error) ?? String(error);
  }
}
/** How many utterances may wait for Whisper or the runtime; past that, speech fails instead of piling up. */
const max_backlog = 4;
/** Refusals that retrying cannot fix. */
const refusals = new Set(["VoiceAttached", "DaemonLacksVoice", "RemoteTooOld", "LocalTooOld", "RemoteMissing"]);

export class VoiceSession {
  history: Utterance[] = [];
  muted = false;
  link_state: LinkState = "connecting";
  /** Why the runtime refused this voice, once `link_state` is "refused". */
  refused: string | null = null;
  /** "crashed" until a fresh server takes over (switching the filter starts one). */
  server: "ready" | "crashed" = "ready";
  private mic: MicProblem | null = null;
  /** The last frame's level on the threshold scale. */
  level = 0;
  /** How far into the silence window the utterance in progress is, 0 to 1. */
  pause = 0;
  /** Whether the runtime has a viewer to type into (without one, voice holds
   * off), and the title of the pane text would go to. */
  viewer = true;
  focus: string | null = null;
  private link: VoiceLink | null = null;
  private next_id = 1;
  private current: Utterance | null = null;
  private transcriptions: Promise<void> = Promise.resolve();
  private deliveries: Promise<void> = Promise.resolve();
  private retry?: ReturnType<typeof setTimeout>;
  private resend?: ReturnType<typeof setTimeout>;
  /** State the runtime has not taken yet, sent again by `resend`. */
  private owed = new Set<"muted" | "available">();
  /** The last state update still on its way; updates go one at a time, so an
   * older answer never settles a newer update. */
  private updating: Promise<void> | null = null;
  private quit = new AbortController();
  /** Retries every 5 s log a failure once, until it changes or the link is back. */
  private link_failure = new Failure();
  private listeners: (() => void)[] = [];
  constructor(
    private deps: {
      /** Connects; `signal` aborts an attempt still in progress when voice mode quits. */
      link: (signal: AbortSignal) => Promise<VoiceLink>;
      transcriber: Pick<Server, "transcribe" | "on">;
      segmenter: Segmenter;
      now: () => number;
      deliverTimeoutMs?: number;
      retryMs?: number;
      /** The voice process's own pane, when it runs inside the target runtime. */
      pane?: number;
      log?: (line: string) => void;
      /** Takes the passages of a transcript recording. */
      recorder?: Recorder;
    },
  ) {
    deps.transcriber.on("crashed", () => this.crashed());
  }
  get available(): boolean {
    return !this.mic && this.server === "ready";
  }
  /** Why voice cannot listen; the server going down outranks the microphone. */
  get unavailable(): Unavailable | null {
    return this.server === "crashed" ? "server_down" : this.mic;
  }
  on(_event: "change", fn: () => void): void {
    this.listeners.push(fn);
  }
  private changed(): void {
    for (const fn of this.listeners) fn();
  }
  /** Attaches to the runtime, or throws what went wrong. A failure that a
   * retry can fix schedules one, so a caller that gives up must close(). */
  async connect(): Promise<void> {
    if (this.link_state === "closed") return;
    this.link_state = "connecting";
    this.changed();
    let link: VoiceLink | null = null;
    try {
      link = await this.deps.link(this.quit.signal);
      if (this.isClosed()) return link.close();
      const attached = link,
        sent = { muted: this.muted, available: this.available };
      attached.on("muted", muted => this.applyMuted(muted));
      attached.on("viewer", state => this.applyViewer(state));
      attached.on("closed", why => this.lost(attached, why));
      const reply = await attached.watch({ pane: this.deps.pane, ...sent });
      if (this.isClosed()) return attached.close();
      this.applyViewer(reply);
      this.link = attached;
      this.link_state = "connected";
      this.link_failure.clear();
      this.deps.log?.("link: connected");
      // A change made while the watch was on its way still has to go out.
      this.owed.clear();
      const changed = (["muted", "available"] as const).filter(k => sent[k] !== this[k]);
      if (changed.length) this.push(...changed);
      this.changed();
    } catch (error) {
      link?.close();
      if (this.isClosed()) return;
      if (refusals.has(errors.name(error) ?? "")) {
        this.link_state = "refused";
        this.refused = errors.name(error);
      } else {
        this.link_state = "lost";
        this.schedule();
      }
      if (this.link_failure.changed(error)) this.deps.log?.(`link: ${errors.name(error) ?? error}`);
      this.changed();
      throw error;
    }
  }
  /** Checked again after each wait: quitting can happen meanwhile. */
  private isClosed(): boolean {
    return this.link_state === "closed";
  }
  private lost(link: VoiceLink, why: string): void {
    if (this.link !== link || this.link_state === "closed") return;
    this.link = null;
    this.link_state = "lost";
    this.deps.log?.(`link: lost (${why})`);
    this.changed();
    this.schedule();
  }
  private schedule(): void {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect().catch(() => {}), this.deps.retryMs ?? 5000);
  }
  frame(f: Int16Array): void {
    this.level = level.rmsToPercent(level.rms(f));
    // Frames again after a microphone failure: it is back.
    if (this.mic) this.setAvailable(true, null);
    // A running recording keeps listening while muted or without a viewer.
    if (!this.available || (!this.recordingRuns && (this.muted || !this.viewer))) {
      // The recording paused or stopped in the middle of a muted passage.
      if (this.current) {
        this.deps.segmenter.abort();
        this.current.status = this.muted ? "muted" : "discarded";
        this.current.reason = this.muted ? null : "no viewer";
        this.current = null;
        this.changed();
      }
      this.pause = 0;
      return;
    }
    const done = this.deps.segmenter.push(f);
    this.pause = this.deps.segmenter.pause;
    for (const segment of done) this.segmented(segment);
    if (this.deps.segmenter.recording && !this.current) {
      this.current = this.utterance("recording");
      // Speech that began muted stays untyped, even if unmuted before it ends.
      if (this.muted) this.untype(this.current, "muted");
      this.changed();
    } else if (!this.deps.segmenter.recording && this.current) {
      // Too little speech to count.
      this.current.status = "dropped";
      this.current.reason = "too short";
      this.current = null;
      this.changed();
    }
  }
  private utterance(status: UtteranceStatus): Utterance {
    const u: Utterance = {
      id: this.next_id++,
      captured_at: this.deps.now(),
      duration: 0,
      status,
      text: null,
      reason: null,
      timings: {},
      record: null,
      untyped: null,
      speech_start: 0,
      speech_end: 0,
      capped: false,
      continues: false,
    };
    this.history.push(u);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    return u;
  }
  private segmented(segment: Segment): void {
    const u = this.current ?? this.utterance("recording");
    this.current = null;
    u.captured_at = segment.started_at;
    u.duration = segment.duration;
    u.speech_start = segment.speech_start;
    u.speech_end = segment.speech_end;
    u.capped = segment.capped;
    u.continues = segment.continues;
    this.deps.recorder?.claim(u);
    if (!u.record && (this.muted || !this.viewer))
      return this.finish(u, this.muted ? "muted" : "discarded", this.muted ? null : "no viewer");
    // A recorded passage is written whether or not it can be typed; the link
    // is checked when it is typed, as for any passage.
    const why: Untyped | null = this.muted ? "muted" : !this.viewer ? "no_viewer" : null;
    if (u.record && why) this.untype(u, why);
    // Speech this far behind Whisper or the runtime is not kept on top; a
    // recorded passage is still written, only not typed.
    if (this.pending >= max_backlog) {
      if (!u.record) return this.finish(u, "failed", "backlog");
      this.untype(u, "backlog");
    }
    u.status = "transcribing";
    this.changed();
    this.transcriptions = this.transcriptions.then(() => this.transcribe(u, segment));
  }
  /** `u` is no longer typed, for `why`; the first reason stays. */
  private untype(u: Utterance, why: Untyped): void {
    if (u.untyped) return;
    u.untyped = why;
    u.reason = untyped_reason[why];
  }
  /** A recording is running, so speech is heard even when it cannot be typed. */
  private get recordingRuns(): boolean {
    return this.deps.recorder?.current?.state === "running";
  }
  /** Utterances waiting for Whisper or for the runtime, each holding its audio or text. */
  private get pending(): number {
    let n = 0;
    for (const u of this.history) if (u.status === "transcribing" || u.status === "delivering") n++;
    return n;
  }
  private async transcribe(u: Utterance, segment: Segment): Promise<void> {
    try {
      await this.heard(u, segment);
    } finally {
      // Whatever ended it without a write, a stop need not wait for it.
      this.deps.recorder?.release(u);
    }
  }
  private async heard(u: Utterance, segment: Segment): Promise<void> {
    if (u.status !== "transcribing") return;
    const started = this.deps.now();
    let heard: string;
    try {
      heard = await this.deps.transcriber.transcribe(wav.encode(segment.pcm));
    } catch (error) {
      if (u.status === "transcribing")
        this.finish(u, "failed", this.server === "crashed" ? "server crashed" : reason(error));
      return;
    }
    u.timings.transcribe_ms = this.deps.now() - started;
    if (u.status !== "transcribing") return;
    const cleaned = text.clean(heard);
    if (cleaned === null) return this.finish(u, "dropped", heard.trim() ? "not speech" : "empty");
    u.text = cleaned;
    if (u.record && !this.deps.recorder?.write(u, cleaned)) u.record = null;
    this.changed();
    this.deliveries = this.deliveries.then(() => this.deliver(u));
  }
  private async deliver(u: Utterance): Promise<void> {
    if (u.status !== "transcribing") return;
    if (u.untyped) return this.finish(u, ...this.untypedEnd(u, u.untyped));
    const link = this.link;
    if (!link || this.link_state !== "connected")
      return this.finish(u, u.record ? "recorded" : "failed", "not connected");
    u.status = "delivering";
    this.changed();
    const started = this.deps.now();
    try {
      await bounded(link.type(u.text!), this.deps.deliverTimeoutMs ?? 2000);
      u.timings.deliver_ms = this.deps.now() - started;
      this.finish(u, "delivered", null);
    } catch (error) {
      u.timings.deliver_ms = this.deps.now() - started;
      // Written to the transcript, so it is kept as recorded, with why it was not typed.
      if (u.record) this.finish(u, "recorded", errors.name(error) === "VoiceMuted" ? "muted" : reason(error));
      // Muted from a viewer before this arrived: dropped, as a mute here drops it.
      else if (errors.name(error) === "VoiceMuted") this.finish(u, "muted", null);
      // The text was sent; only the answer is missing, so it may still arrive.
      else if (errors.is(error, "Timeout")) this.finish(u, "failed", "no answer in time; may have been typed");
      else this.finish(u, "failed", reason(error));
    }
  }
  /** How a passage that is not typed ends: recorded when it was written. */
  private untypedEnd(u: Utterance, why: Untyped): [UtteranceStatus, string | null] {
    if (u.record) return ["recorded", untyped_reason[why]];
    if (why === "muted") return ["muted", null];
    return ["discarded", why === "no_viewer" ? "no viewer" : untyped_reason[why]];
  }
  private finish(u: Utterance, status: UtteranceStatus, why: string | null): void {
    u.status = status;
    u.reason = why;
    const t = u.timings;
    this.deps.log?.(
      `utterance ${u.id}: ${status}${why ? ` (${why})` : ""} duration=${u.duration}s` +
        (t.transcribe_ms !== undefined ? ` transcribe_ms=${t.transcribe_ms}` : "") +
        (t.deliver_ms !== undefined ? ` deliver_ms=${t.deliver_ms}` : ""),
    );
    this.changed();
  }
  /** Mute or unmute from this side; the runtime hears of it. */
  setMuted(muted: boolean): void {
    if (!muted && !this.available) return;
    this.applyMuted(muted);
    this.push("muted");
  }
  /** Tells the runtime what changed here, and only that, so an update on its
   * way never overwrites a change a viewer made meanwhile. What the runtime
   * did not take is sent again a second later. A queued update reads the state
   * as it goes out, so it carries a viewer's change rather than undo it. */
  private push(...keys: ("muted" | "available")[]): void {
    const link = this.link;
    if (!link || !keys.length) return;
    const send = () =>
      link.set(Object.fromEntries(keys.map(k => [k, this[k]]))).then(
        () => {
          for (const k of keys) this.owed.delete(k);
        },
        () => {
          if (this.link !== link) return;
          for (const k of keys) this.owed.add(k);
          clearTimeout(this.resend);
          this.resend = setTimeout(() => this.push(...this.owed), 1000);
        },
      );
    const update = this.updating ? this.updating.then(send) : send();
    this.updating = update;
    void update.then(() => {
      if (this.updating === update) this.updating = null;
    });
  }
  /** Mute from either side drops what was not yet delivered. */
  private applyMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    if (muted) this.discard("muted", null, "muted");
    this.changed();
  }
  /** A viewer attached or went away; what is said meanwhile has nowhere to go. */
  private applyViewer(state: Seen): void {
    if (this.viewer === state.viewer && this.focus === state.focus) return;
    if (this.viewer && !state.viewer) this.discard("discarded", "no viewer", "no_viewer");
    this.viewer = state.viewer;
    this.focus = state.focus;
    this.changed();
  }
  /** Speech is being recorded. */
  get recording(): boolean {
    return this.history.some(u => u.status === "recording");
  }
  get transcribing(): boolean {
    return this.history.some(u => u.status === "transcribing");
  }
  /** Drops what was not yet typed. A passage for a transcript is still
   * written, only not typed (for `untyped`); while a recording runs, the
   * passage in progress goes on, to be written when it ends. */
  private discard(status: "muted" | "discarded", why: string | null, untyped: Untyped): void {
    const listening = this.recordingRuns;
    if (!listening) {
      this.deps.segmenter.abort();
      this.current = null;
    } else if (this.current) this.untype(this.current, untyped);
    for (const u of this.history)
      if (u.record && u.status === "transcribing") this.untype(u, untyped);
      else if (u.status === "transcribing" || (u.status === "recording" && !listening)) {
        u.status = status;
        u.reason = why;
      }
  }
  /** The microphone stopped (`available` false, and why) or came back. */
  setAvailable(available: boolean, why: MicProblem | null): void {
    const next = available ? null : (why ?? "mic_missing");
    if (this.mic === next) return;
    const was = this.available;
    this.mic = next;
    this.availability(was);
  }
  private availability(was: boolean): void {
    if (!this.available) {
      this.deps.segmenter.abort();
      if (this.current) this.current.status = "dropped";
      this.current = null;
    }
    this.deps.log?.(this.available ? "listening again" : `cannot listen: ${this.unavailable}`);
    if (was !== this.available) this.push("available");
    this.changed();
  }
  private crashed(): void {
    const was = this.available;
    this.server = "crashed";
    // Text already transcribed can still be delivered.
    for (const u of this.history)
      if ((u.status === "transcribing" && u.text === null) || u.status === "recording") {
        u.status = "failed";
        u.reason = "server crashed";
        this.deps.recorder?.release(u);
      }
    this.availability(was);
  }
  /** A fresh server took over; after a crash, voice listens again. */
  serverReady(): void {
    if (this.server === "ready") return;
    const was = this.available;
    this.server = "ready";
    this.availability(was);
  }
  close(): void {
    this.link_state = "closed";
    this.quit.abort();
    clearTimeout(this.retry);
    clearTimeout(this.resend);
    this.link?.close();
    this.link = null;
  }
}
