import { test, expect } from "bun:test";
import * as turns from "./turns";

/** A passage of `text` from `start` to `end` ms. */
const p = (
  text: string,
  start: number,
  end: number,
  extra: { cut_at?: number; continues?: boolean; dash?: boolean } = {},
) => ({
  text,
  speech_start: start,
  speech_end: end,
  cut_at: extra.cut_at ?? null,
  continues: extra.continues ?? false,
  dash: extra.dash ?? false,
});

test("speakerDash strips a leading dash of any kind", () => {
  for (const d of ["-", "–", "—"]) {
    expect(turns.speakerDash(`${d} Sure, go ahead.`)).toEqual({ text: "Sure, go ahead.", dash: true });
    expect(turns.speakerDash(`${d}\tNext`)).toEqual({ text: "Next", dash: true });
    expect(turns.speakerDash(d)).toEqual({ text: "", dash: true });
    expect(turns.speakerDash(` ${d} `)).toEqual({ text: "", dash: true });
  }
});

test("speakerDash leaves other dashes as text", () => {
  expect(turns.speakerDash("well - maybe")).toEqual({ text: "well - maybe", dash: false });
  expect(turns.speakerDash("a — b")).toEqual({ text: "a — b", dash: false });
  expect(turns.speakerDash("-5 degrees")).toEqual({ text: "-5 degrees", dash: false });
  expect(turns.speakerDash("--flag")).toEqual({ text: "--flag", dash: false });
  expect(turns.speakerDash("—quote")).toEqual({ text: "—quote", dash: false });
});

test("the first passage starts a contribution", () => {
  const t = new turns.Turns(2);
  expect(t.next(p("one", 1000, 2000))).toBe(true);
  expect(t.contributions).toEqual([{ started_at: 1000, texts: ["one"] }]);
});

test("a gap longer than pause_break starts a contribution", () => {
  const t = new turns.Turns(2);
  t.next(p("one", 0, 1000));
  expect(t.next(p("two", 3000, 4000))).toBe(false); // exactly 2 s
  expect(t.next(p("three", 6001, 7000))).toBe(true); // 2.001 s
  expect(t.next(p("four", 7500, 8000))).toBe(false);
  expect(t.contributions).toEqual([
    { started_at: 0, texts: ["one", "two"] },
    { started_at: 6001, texts: ["three", "four"] },
  ]);
});

test("the rest of a capped passage continues its contribution", () => {
  const t = new turns.Turns(2);
  t.next(p("long", 0, 7_000, { cut_at: 10_000 }));
  // Quiet up to the cut does not count as a pause.
  expect(t.next(p("rest", 10_000, 11_000, { continues: true }))).toBe(false);
  // The gap rule applies again to a passage that does not continue a cut.
  expect(t.next(p("later", 30_000, 31_000))).toBe(true);
});

test("after a cut whose rest was dropped, a long pause still starts a contribution", () => {
  const t = new turns.Turns(2);
  t.next(p("long", 0, 10_000, { cut_at: 10_000 }));
  // The quiet rest after the cut never reached the recorder; another speaker follows.
  expect(t.next(p("reply", 14_000, 15_000))).toBe(true);
});

test("a continuation of another speaker's cut does not inherit an earlier one", () => {
  const t = new turns.Turns(2);
  // Cut at 10 s; the rest of it was dropped.
  t.next(p("long", 0, 9_900, { cut_at: 10_000 }));
  // Another speaker's capped head (20 to 30 s) was filtered out; its rest arrives.
  expect(t.next(p("rest", 30_000, 31_000, { continues: true }))).toBe(true);
});

test("the rest of a cut whose head was not written is measured from the last written passage", () => {
  const t = new turns.Turns(2);
  t.next(p("before", 0, 1000));
  // The capped head at 6 to 16 s was filtered out; its rest still says it continues.
  expect(t.next(p("rest", 16_000, 17_000, { continues: true }))).toBe(true);
  expect(t.contributions.map(c => c.texts)).toEqual([["before"], ["rest"]]);
});

test("a speaker dash starts a contribution", () => {
  const t = new turns.Turns(2);
  t.next(p("one", 0, 1000));
  expect(t.next(p("two", 1100, 2000, { dash: true }))).toBe(true);
  // Even right after a cut at the cap.
  t.next(p("long", 2100, 12_100, { cut_at: 12_100 }));
  expect(t.next(p("reply", 12_100, 13_000, { continues: true, dash: true }))).toBe(true);
  expect(t.contributions.map(c => c.texts)).toEqual([["one"], ["two", "long"], ["reply"]]);
});

test("a break goes to the first passage spoken at or after it", () => {
  const t = new turns.Turns(2);
  t.next(p("one", 0, 1000));
  t.breakAt(1100);
  expect(t.next(p("two", 1100, 2000))).toBe(true);
  expect(t.next(p("three", 2100, 3000))).toBe(false);
  // A break also overrides a passage that continues a cut.
  t.next(p("long", 3100, 13_100, { cut_at: 13_100 }));
  t.breakAt(13_000);
  expect(t.next(p("after", 13_100, 14_000, { continues: true }))).toBe(true);
  expect(t.contributions).toEqual([
    { started_at: 0, texts: ["one"] },
    { started_at: 1100, texts: ["two", "three", "long"] },
    { started_at: 13_100, texts: ["after"] },
  ]);
});

test("a passage spoken before a break and written after it does not take it", () => {
  const t = new turns.Turns(2);
  t.next(p("before", 0, 1000));
  // Paused at 1500, resumed later; the passage from 1200 was still being transcribed.
  t.breakAt(1500);
  expect(t.next(p("late", 1200, 1400))).toBe(false);
  // The first passage spoken after the pause takes the break, however short the gap.
  expect(t.next(p("after", 1600, 2000))).toBe(true);
  // The pause rule still applies to the late passage.
  t.breakAt(9000);
  expect(t.next(p("late and far", 5000, 6000))).toBe(true);
  expect(t.next(p("resumed", 9100, 9500))).toBe(true);
  expect(t.contributions.map(c => c.texts)).toEqual([["before", "late"], ["after"], ["late and far"], ["resumed"]]);
});

test("breaks from two pauses go to the first passage after each", () => {
  const t = new turns.Turns(2);
  t.next(p("one", 0, 1000));
  t.breakAt(1500);
  t.breakAt(3000);
  expect(t.next(p("between", 2000, 2200))).toBe(true);
  expect(t.next(p("after", 3100, 3300))).toBe(true);
  expect(t.next(p("more", 3400, 3600))).toBe(false);
});

test("pause_break is in seconds", () => {
  const t = new turns.Turns(0.5);
  expect(t.pause_break).toBe(0.5);
  t.next(p("one", 0, 1000));
  expect(t.next(p("two", 1500, 2000))).toBe(false);
  expect(t.next(p("three", 2501, 3000))).toBe(true);
});
