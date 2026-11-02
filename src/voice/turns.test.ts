import { test, expect } from "bun:test";
import * as turns from "./turns";

/** A passage of `text` from `start` to `end` ms. */
const p = (
  text: string,
  start: number,
  end: number,
  extra: { capped?: boolean; continues?: boolean; dash?: boolean } = {},
) => ({
  text,
  speech_start: start,
  speech_end: end,
  capped: extra.capped ?? false,
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
  t.next(p("long", 0, 7_000, { capped: true }));
  // Quiet up to the cut does not count as a pause.
  expect(t.next(p("rest", 10_000, 11_000, { continues: true }))).toBe(false);
  // The gap rule applies again to a passage that does not continue a cut.
  expect(t.next(p("later", 30_000, 31_000))).toBe(true);
});

test("after a cut whose rest was dropped, a long pause still starts a contribution", () => {
  const t = new turns.Turns(2);
  t.next(p("long", 0, 10_000, { capped: true }));
  // The quiet rest after the cut never reached the recorder; another speaker follows.
  expect(t.next(p("reply", 14_000, 15_000))).toBe(true);
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
  t.next(p("long", 2100, 12_100, { capped: true }));
  expect(t.next(p("reply", 12_100, 13_000, { continues: true, dash: true }))).toBe(true);
  expect(t.contributions.map(c => c.texts)).toEqual([["one"], ["two", "long"], ["reply"]]);
});

test("reset makes the next passage start a contribution", () => {
  const t = new turns.Turns(2);
  t.next(p("one", 0, 1000));
  t.reset();
  expect(t.next(p("two", 1100, 2000))).toBe(true);
  expect(t.next(p("three", 2100, 3000))).toBe(false);
  // Reset also overrides a passage that continues a cut.
  t.next(p("long", 3100, 13_100, { capped: true }));
  t.reset();
  expect(t.next(p("after", 13_100, 14_000, { continues: true }))).toBe(true);
  expect(t.contributions).toEqual([
    { started_at: 0, texts: ["one"] },
    { started_at: 1100, texts: ["two", "three", "long"] },
    { started_at: 13_100, texts: ["after"] },
  ]);
});

test("pause_break is in seconds", () => {
  const t = new turns.Turns(0.5);
  expect(t.pause_break).toBe(0.5);
  t.next(p("one", 0, 1000));
  expect(t.next(p("two", 1500, 2000))).toBe(false);
  expect(t.next(p("three", 2501, 3000))).toBe(true);
});
