import { test, expect } from "bun:test";
import { Tuning } from "./tuning";
import type { Timing } from "./segmenter";
import type { RecordingSettings } from "./settings";

/** A segmenter stand-in that keeps what was applied last, and every call. */
function target() {
  const t = {
    calls: [] as string[],
    threshold: NaN,
    timing: {} as Partial<Timing>,
    cap: NaN,
    setThreshold(pct: number) {
      t.calls.push(`threshold ${pct}`);
      t.threshold = pct;
    },
    setTiming(name: keyof Timing, seconds: number) {
      t.calls.push(`${name} ${seconds}`);
      t.timing[name] = seconds;
    },
    setCap(seconds: number) {
      t.calls.push(`cap ${seconds}`);
      t.cap = seconds;
    },
  };
  return t;
}

function make(recording: Partial<RecordingSettings> = {}) {
  const seg = target();
  const tuning = new Tuning(seg, {
    dictation: { threshold: 44, silence: 2.5 },
    recording: { threshold: null, silence: 1, max_chunk: 10, pause_break: 2, ...recording },
    shared: { burst: 0.1, pre_roll: 0.3, min_speech: 0.2 },
  });
  return { seg, tuning };
}

test("the constructor applies nothing; the dictation values are in effect", () => {
  const { seg, tuning } = make();
  expect(seg.calls).toEqual([]);
  expect(tuning.active).toBe("dictation");
  expect(tuning.threshold).toBe(44);
  expect(tuning.timing).toEqual({ silence: 2.5, burst: 0.1, pre_roll: 0.3, min_speech: 0.2 });
  expect(tuning.pause_break).toBe(2);
});

test("begin applies the recording set with its cap, end restores dictation and 30 s", () => {
  const { seg, tuning } = make({ threshold: 60 });
  tuning.begin();
  expect(tuning.active).toBe("recording");
  expect(seg.calls).toEqual(["threshold 60", "silence 1", "cap 10"]);
  expect(tuning.threshold).toBe(60);
  expect(tuning.timing.silence).toBe(1);
  tuning.end();
  expect(tuning.active).toBe("dictation");
  expect(seg.calls.slice(3)).toEqual(["threshold 44", "silence 2.5", "cap 30"]);
  expect(tuning.threshold).toBe(44);
  expect(tuning.timing.silence).toBe(2.5);
});

test("end restores the dictation values changed before the recording", () => {
  const { seg, tuning } = make({ threshold: 60 });
  tuning.setThreshold(50);
  tuning.setSilence(3);
  tuning.begin();
  // Changes during the recording go to the recording set.
  tuning.setThreshold(70);
  tuning.setTiming("silence", 1.5);
  expect(seg.threshold).toBe(70);
  expect(seg.timing.silence).toBe(1.5);
  tuning.end();
  expect([seg.threshold, seg.timing.silence, seg.cap]).toEqual([50, 3, 30]);
  expect(tuning.threshold).toBe(50);
  expect(tuning.timing.silence).toBe(3);
});

test("values adjusted during a recording stay for the next one", () => {
  const { seg, tuning } = make();
  tuning.begin();
  tuning.setThreshold(55);
  tuning.setSilence(2);
  tuning.end();
  tuning.setThreshold(40);
  tuning.begin();
  expect([seg.threshold, seg.timing.silence, seg.cap]).toEqual([55, 2, 10]);
  expect(tuning.threshold).toBe(55);
});

test("an unset recording threshold follows dictation until adjusted in a recording", () => {
  const { seg, tuning } = make();
  tuning.begin();
  expect(seg.threshold).toBe(44);
  expect(tuning.threshold).toBe(44);
  tuning.end();
  // Dictation moved on: the next recording follows it.
  tuning.setThreshold(48);
  tuning.begin();
  expect(seg.threshold).toBe(48);
  // Adjusted now, it no longer follows.
  tuning.setThreshold(52);
  tuning.end();
  expect(seg.threshold).toBe(48);
  tuning.setThreshold(30);
  tuning.begin();
  expect(seg.threshold).toBe(52);
});

test("burst, pre-roll and minimum speech are shared and not undone by end", () => {
  const { seg, tuning } = make();
  tuning.begin();
  tuning.setTiming("burst", 0.2);
  tuning.setTiming("pre_roll", 0.5);
  tuning.setTiming("min_speech", 0.4);
  expect(seg.calls.slice(3)).toEqual(["burst 0.2", "pre_roll 0.5", "min_speech 0.4"]);
  tuning.end();
  // end touches only threshold, silence and cap.
  expect(seg.calls.slice(6)).toEqual(["threshold 44", "silence 2.5", "cap 30"]);
  expect(tuning.timing).toEqual({ silence: 2.5, burst: 0.2, pre_roll: 0.5, min_speech: 0.4 });
  // Set during dictation, they hold in the next recording too.
  tuning.setTiming("burst", 0.05);
  tuning.begin();
  expect(tuning.timing).toEqual({ silence: 1, burst: 0.05, pre_roll: 0.5, min_speech: 0.4 });
});

test("the settings object passed in is not changed", () => {
  const recording: RecordingSettings = { threshold: null, silence: 1, max_chunk: 10, pause_break: 2 };
  const tuning = new Tuning(target(), {
    dictation: { threshold: 44, silence: 2.5 },
    recording,
    shared: { burst: 0.1, pre_roll: 0.3, min_speech: 0.2 },
  });
  tuning.begin();
  tuning.setThreshold(60);
  expect(recording.threshold).toBeNull();
});
