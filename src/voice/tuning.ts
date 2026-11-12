//! The segmenter values in effect. Outside a recording the dictation set
//! applies; while one runs (also paused) the recording set does. Threshold and
//! silence changes go to whichever set is active, though a threshold set during
//! a recording ends with it; the other timings are shared.
import type { Segmenter, Timing } from "./segmenter";
import type { RecordingSettings } from "./settings";

/** Dictation has no cap setting: it cuts at the 30 s transcription window. */
const dictation_cap = 30;

type Target = Pick<Segmenter, "setThreshold" | "setTiming" | "setCap">;
type Shared = { burst: number; pre_roll: number; post_roll: number; min_speech: number };

export class Tuning {
  private readonly target: Target;
  private readonly dictation: { threshold: number; silence: number };
  private readonly recording: RecordingSettings;
  private readonly shared: Shared;
  private mode: "dictation" | "recording" = "dictation";
  private readonly warn: (text: string) => void;
  /** Applies nothing: main.ts builds the segmenter with the dictation values and
   * the shared timings, which is the state this starts in. */
  constructor(
    target: Target,
    init: {
      dictation: { threshold: number; silence: number };
      recording: RecordingSettings;
      shared: Shared;
      /** Says when a change leaves every passage its own contribution. */
      warn?: (text: string) => void;
    },
  ) {
    this.target = target;
    this.warn = init.warn ?? (() => {});
    this.dictation = { ...init.dictation };
    this.recording = { ...init.recording };
    this.shared = { ...init.shared };
  }
  get active(): "dictation" | "recording" {
    return this.mode;
  }
  /** A threshold set during the current recording; every recording starts without one. */
  private adjusted: number | null = null;
  /** The threshold in effect. A recording starts from `recording.threshold`, or
   * when that is null from the dictation threshold, which cannot change while it runs. */
  get threshold(): number {
    return this.mode === "recording"
      ? (this.adjusted ?? this.recording.threshold ?? this.dictation.threshold)
      : this.dictation.threshold;
  }
  /** All timings in effect, in seconds. */
  get timing(): Timing {
    const silence = this.mode === "recording" ? this.recording.silence : this.dictation.silence;
    return { silence, ...this.shared };
  }
  get pause_break(): number {
    return this.recording.pause_break;
  }
  /** A recording starts: its set applies. */
  begin(): void {
    this.mode = "recording";
    this.adjusted = null;
    this.target.setThreshold(this.threshold);
    this.target.setTiming("silence", this.recording.silence);
    this.target.setCap(this.recording.max_chunk);
  }
  /** The recording stopped: the dictation set applies again. */
  end(): void {
    this.mode = "dictation";
    this.adjusted = null;
    this.target.setThreshold(this.dictation.threshold);
    this.target.setTiming("silence", this.dictation.silence);
    this.target.setCap(dictation_cap);
  }
  /** Sets the active threshold. Set during a recording, it lasts until that recording stops. */
  setThreshold(pct: number): void {
    if (this.mode === "recording") this.adjusted = pct;
    else this.dictation.threshold = pct;
    this.target.setThreshold(pct);
  }
  /** Sets the active silence window, in seconds. */
  setSilence(seconds: number): void {
    if (this.mode === "recording") {
      const { silence: before, pause_break } = this.recording;
      this.recording.silence = seconds;
      // As voice.json's check does at start, for a change made while recording.
      if (before < pause_break && seconds >= pause_break)
        this.warn(
          `recording "pause_break" (${pause_break} s) is not longer than "silence" (${seconds} s), so every passage starts a new contribution`,
        );
    } else this.dictation.silence = seconds;
    this.target.setTiming("silence", seconds);
  }
  /** Sets one timing, in seconds: `silence` for the active set, the others for both. */
  setTiming(name: keyof Timing, seconds: number): void {
    if (name === "silence") return this.setSilence(seconds);
    this.shared[name] = seconds;
    this.target.setTiming(name, seconds);
  }
}
