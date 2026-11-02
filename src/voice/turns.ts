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
  /** The next passage starts a contribution. */
  private fresh = true;
  private last_end = 0;
  private last_capped = false;
  constructor(pause_break: number) {
    this.pause_break = pause_break;
  }
  /** The next passage starts a contribution (start and resume). */
  reset(): void {
    this.fresh = true;
  }
  /** Adds a written passage; times in ms. Returns whether it starts a contribution. */
  next(p: { text: string; speech_start: number; speech_end: number; capped: boolean; dash: boolean }): boolean {
    const gap = !this.last_capped && p.speech_start - this.last_end > this.pause_break * 1000;
    const starts = this.fresh || p.dash || gap || this.contributions.length === 0;
    this.fresh = false;
    this.last_end = p.speech_end;
    this.last_capped = p.capped;
    if (starts) this.contributions.push({ started_at: p.speech_start, texts: [p.text] });
    else this.contributions[this.contributions.length - 1].texts.push(p.text);
    return starts;
  }
}
