//! Where a recording's passages split into contributions: after a long
//! pause, at a speaker dash, and at the start or resume of a recording.

/** A leading hyphen, en dash or em dash followed by whitespace, or alone. */
const dash = /^[-\u2013\u2014](?:\s+|$)/;

/** `text` without a leading speaker dash, and whether it had one. Text that is
 * only a dash comes back empty. Dashes elsewhere are ordinary text. */
export function speakerDash(text: string): { text: string; dash: boolean } {
  const trimmed = text.trim();
  const match = dash.exec(trimmed);
  if (!match) return { text, dash: false };
  return { text: trimmed.slice(match[0].length), dash: true };
}

/** Passages one speaker said in a row; `started_at` is the first one's speech start (ms). */
export type Contribution = { started_at: number; texts: string[] };

export class Turns {
  /** Silence, in seconds, that starts a new contribution. */
  readonly pause_break: number;
  contributions: Contribution[] = [];
  /** Breaks still to come, as speech times (ms): the next passage spoken at
   * or after one starts a contribution. The first passage always does. */
  private breaks: number[] = [-Infinity];
  private last_end = 0;
  /** Where the cap cut the last written passage (ms), or null. */
  private last_cut: number | null = null;
  constructor(pause_break: number) {
    this.pause_break = pause_break;
  }
  /** The first passage spoken at or after `at` (ms) starts a contribution,
   * whenever it is written: a resume breaks by when speech began, so a
   * passage said before the pause and written after the resume does not
   * take the break. */
  breakAt(at: number): void {
    this.breaks.push(at);
  }
  /** Adds a written passage; times in ms. Returns whether it starts a contribution.
   * A passage that `continues` the very cut of the last written one (it
   * starts where that one was cut) has no pause before it. When either side
   * of a cut was not written, the pause is measured from the last written
   * passage as usual. */
  next(p: {
    text: string;
    speech_start: number;
    speech_end: number;
    cut_at: number | null;
    continues: boolean;
    dash: boolean;
  }): boolean {
    const carried = p.continues && p.speech_start === this.last_cut,
      gap = !carried && p.speech_start - this.last_end > this.pause_break * 1000;
    const due = this.breaks.some(at => p.speech_start >= at);
    if (due) this.breaks = this.breaks.filter(at => p.speech_start < at);
    const starts = due || p.dash || gap;
    this.last_end = p.speech_end;
    this.last_cut = p.cut_at;
    if (starts) this.contributions.push({ started_at: p.speech_start, texts: [p.text] });
    else this.contributions[this.contributions.length - 1].texts.push(p.text);
    return starts;
  }
}
