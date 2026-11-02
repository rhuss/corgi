//! Cuts the microphone stream into utterances by level. Time is counted in
//! frames, so a stream fed faster than real time segments the same way.
import * as level from "./level";

/** An utterance. Times are ms on the `now()` clock, counted in frames from the
 * utterance's first frame:
 * - `speech_start`: the first loud frame, without pre-roll; after a cut at the
 *   cap, the first frame after the cut;
 * - `speech_end`: the end of the last loud frame, without the quiet after it;
 * - `capped`: cut at the cap, so the next segment carries on the same speech;
 * - `cut_at`: where the cap cut it, which is the next segment's `speech_start`;
 * - `continues`: starts at such a cut, carrying on the previous segment. */
export type Segment = {
  pcm: Int16Array;
  started_at: number;
  duration: number;
  speech_start: number;
  speech_end: number;
  capped: boolean;
  cut_at: number | null;
  continues: boolean;
};
/** The times, in seconds, that start and end an utterance:
 * - `silence`: the pause that ends it;
 * - `pre_roll`: audio kept from before it started, so the first syllable stays;
 * - `min_speech`: loud time it needs to count at all;
 * - `burst`: loud time in a row that counts as speaking again; shorter peaks,
 *   such as music under the threshold, neither end nor extend the silence. */
export type Timing = { silence: number; pre_roll: number; min_speech: number; burst: number };
export const default_timing: Timing = { silence: 2.5, pre_roll: 0.3, min_speech: 0.2, burst: 0.1 };

const frame_ms = 20,
  /** The longest utterance, the transcription window. */
  max_cap_frames = 30_000 / frame_ms,
  /** What is kept of the quiet after the last burst. */
  trail_frames = 300 / frame_ms;
/** `seconds` in whole frames, at least one. */
const frames = (seconds: number) => Math.max(1, Math.round((seconds * 1000) / frame_ms));

export class Segmenter {
  private threshold: number;
  private silence_frames: number;
  private preroll_frames: number;
  private min_speech_frames: number;
  private burst_frames: number;
  private readonly now: () => number;
  private preroll: Int16Array[] = [];
  private frames: Int16Array[] = [];
  private speech = 0;
  private quiet = 0;
  /** Loud frames in a row, and all frames since the last burst. */
  private run = 0;
  private tail = 0;
  private started_at = 0;
  /** The time of the utterance's first frame, counted in frames across cuts. */
  private origin = 0;
  /** Frames before the first loud one: the pre-roll, none after a cut. */
  private lead = 0;
  /** The utterance in progress began at a cut at the cap. */
  private continued = false;
  private cap_frames = max_cap_frames;
  private active = false;
  constructor(opts: { threshold: number; timing?: Partial<Timing>; now: () => number }) {
    this.threshold = level.percentToRms(opts.threshold);
    const t = { ...default_timing, ...opts.timing };
    this.silence_frames = frames(t.silence);
    this.preroll_frames = Math.round((t.pre_roll * 1000) / frame_ms);
    this.min_speech_frames = frames(t.min_speech);
    this.burst_frames = frames(t.burst);
    this.now = opts.now;
  }
  get recording(): boolean {
    return this.active;
  }
  setThreshold(pct: number): void {
    this.threshold = level.percentToRms(pct);
  }
  /** One of the timings, in seconds, from the next frame on. */
  setTiming(name: keyof Timing, seconds: number): void {
    if (name === "silence") this.silence_frames = frames(seconds);
    else if (name === "pre_roll") {
      this.preroll_frames = Math.round((seconds * 1000) / frame_ms);
      this.preroll.splice(0, Math.max(0, this.preroll.length - this.preroll_frames));
    } else if (name === "min_speech") this.min_speech_frames = frames(seconds);
    else this.burst_frames = frames(seconds);
  }
  /** The length, in seconds, at which an utterance is cut; never past the 30 s
   * transcription window. */
  setCap(seconds: number): void {
    this.cap_frames = Math.min(max_cap_frames, frames(seconds));
  }
  /** How far into the silence window the utterance in progress is, 0 to 1. */
  get pause(): number {
    return this.active ? Math.min(1, this.quiet / this.silence_frames) : 0;
  }
  /** Takes one 20 ms frame; returns the utterances it finished. */
  push(frame: Int16Array): Segment[] {
    const loud = level.rms(frame) >= this.threshold;
    if (!this.active) {
      if (!loud) {
        this.preroll.push(frame);
        if (this.preroll.length > this.preroll_frames) this.preroll.shift();
        return [];
      }
      this.active = true;
      this.started_at = this.origin = this.now() - this.preroll.length * frame_ms;
      this.lead = this.preroll.length;
      this.continued = false;
      this.frames = this.preroll;
      this.preroll = [];
    }
    this.frames.push(frame);
    this.tail++;
    if (loud) {
      this.speech++;
      if (++this.run >= this.burst_frames || this.speech === this.run) this.quiet = this.tail = 0;
      // A peak too short to be speech: the pause runs on through it.
      else this.quiet++;
    } else {
      this.run = 0;
      this.quiet++;
    }
    if (this.quiet >= this.silence_frames) {
      const loud_frames = this.frames.length - this.tail;
      // Keep 0.3 s of what followed the last burst.
      this.frames.length -= Math.max(0, this.tail - trail_frames);
      const done = this.take(loud_frames, false);
      this.active = false;
      return done;
    }
    if (this.frames.length >= this.cap_frames) {
      // A long utterance goes out at the cap; listening carries straight on.
      const taken = this.frames.length,
        done = this.take(taken - this.tail, true);
      this.started_at = this.now();
      this.origin += taken * frame_ms;
      this.lead = 0;
      this.continued = true;
      return done;
    }
    return [];
  }
  /** Drops the utterance in progress. */
  abort(): void {
    this.frames = [];
    this.preroll = [];
    this.speech = this.quiet = this.run = this.tail = 0;
    this.active = false;
  }
  /** The utterance so far; `loud_frames` counts its frames up to the end of the
   * last loud one. */
  private take(loud_frames: number, capped: boolean): Segment[] {
    const frames = this.frames,
      speech = this.speech;
    this.frames = [];
    this.speech = this.quiet = this.run = this.tail = 0;
    if (speech < this.min_speech_frames) return [];
    const pcm = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of frames) {
      pcm.set(f, at);
      at += f.length;
    }
    return [
      {
        pcm,
        started_at: this.started_at,
        duration: (frames.length * frame_ms) / 1000,
        speech_start: this.origin + this.lead * frame_ms,
        speech_end: this.origin + loud_frames * frame_ms,
        capped,
        // Computed as the next segment's start is, so the two compare equal.
        cut_at: capped ? this.origin + frames.length * frame_ms : null,
        continues: this.continued,
      },
    ];
  }
}
