import { test, expect } from "bun:test";
import { Segmenter, type Segment, type Timing } from "./segmenter";
import { shapes, concat, silence, tone } from "../../tests/fixtures/voice/make_pcm";

/** Feeds `pcm` in 20 ms frames on a clock that moves with the frames. */
function feed(pcm: Int16Array, opts: { threshold?: number; cap?: number } & Partial<Timing> = {}) {
  let clock = 0;
  const { threshold = 44, cap, ...timing } = opts;
  const s = new Segmenter({ threshold, timing, now: () => clock }),
    out: Segment[] = [];
  if (cap !== undefined) s.setCap(cap);
  for (let at = 0; at < pcm.length; at += 320) {
    clock += 20;
    out.push(...s.push(pcm.subarray(at, at + 320)));
  }
  return { segmenter: s, segments: out };
}

test("one burst of speech is one utterance, with pre-roll and trimmed silence", () => {
  const { segments, segmenter } = feed(concat(silence(1), shapes.speech()));
  expect(segments).toHaveLength(1);
  // 0.3 s pre-roll, 1.5 s of speech, 0.3 s of the silence.
  expect(segments[0].duration).toBeCloseTo(2.1, 5);
  expect(segments[0].pcm.length).toBe(2.1 * 16000);
  expect(segments[0].started_at).toBe(1000 - 300 + 20);
  expect(segmenter.recording).toBe(false);
});

test("noise below the threshold is no utterance", () => {
  const { segments, segmenter } = feed(shapes.noise());
  expect(segments).toHaveLength(0);
  expect(segmenter.recording).toBe(false);
  // The same noise above the threshold would have been one.
  expect(feed(shapes.noise(), { threshold: 0 }).segments).toHaveLength(1);
});

test("a long utterance goes out at 30 s and listening carries on", () => {
  const { segments } = feed(concat(shapes.long(), silence(3)));
  expect(segments).toHaveLength(2);
  expect(segments[0].duration).toBe(30);
  expect(segments[1].duration).toBeCloseTo(5.3, 5);
});

test("speech times leave out the pre-roll and the quiet after the speech", () => {
  const [s] = feed(concat(silence(1), shapes.speech())).segments;
  // Frames count from started_at, the start of the 0.3 s pre-roll.
  expect(s.speech_start).toBe(s.started_at + 300);
  expect(s.speech_end - s.speech_start).toBe(1500);
  expect(s.capped).toBe(false);
  // Without pre-roll the speech starts with the utterance.
  const [bare] = feed(concat(silence(1), shapes.speech()), { pre_roll: 0 }).segments;
  expect(bare.speech_start).toBe(bare.started_at);
  expect(bare.speech_end - bare.speech_start).toBe(1500);
  // Short peaks after the speech belong to the pause, not to the speech.
  const beats = Array.from({ length: 20 }, () => concat(silence(0.18), tone(0.02)));
  const [music] = feed(concat(tone(1.5), ...beats, silence(3)), { silence: 1 }).segments;
  expect(music.speech_end - music.speech_start).toBe(1500);
  // Two bursts 3 s apart: the gap between them is the quiet, without pre-roll or trail.
  const [a, b] = feed(shapes.two()).segments;
  expect(b.speech_start - a.speech_end).toBe(3000);
});

test("a capped utterance carries on in the next one, without a gap", () => {
  const { segments } = feed(concat(silence(1), tone(35), silence(3)));
  expect(segments.map(s => s.capped)).toEqual([true, false]);
  expect(segments.map(s => s.continues)).toEqual([false, true]);
  const [first, next] = segments;
  expect(first.speech_start).toBe(first.started_at + 300);
  // The cap cuts at 30 s including the pre-roll; the speech runs up to the cut.
  expect(first.speech_end).toBe(first.started_at + 30_000);
  // The next one starts with the first frame after the cut.
  expect(next.speech_start).toBe(first.speech_end);
  expect(next.speech_end - next.speech_start).toBe(5300);
});

test("the cap can be lowered, but not past 30 s", () => {
  const ten = feed(concat(tone(25), silence(3)), { cap: 10 }).segments;
  expect(ten.map(s => s.duration)).toEqual([10, 10, 5.3]);
  expect(ten.map(s => s.capped)).toEqual([true, true, false]);
  expect(ten.map(s => s.continues)).toEqual([false, true, true]);
  expect(ten[1].speech_start).toBe(ten[0].speech_end);
  expect(ten[2].speech_start).toBe(ten[1].speech_end);
  expect(ten[2].speech_end - ten[0].speech_start).toBe(25_000);
  // Asked for more, it stays at the 30 s transcription window.
  expect(feed(concat(shapes.long(), silence(3)), { cap: 60 }).segments.map(s => s.duration)).toEqual([30, 5.3]);
});

test("speech after a cut whose quiet rest was dropped does not continue it", () => {
  // Speech stops 0.1 s before the cut: the rest is too short and is dropped.
  const { segments } = feed(concat(tone(9.9), silence(4), tone(1), silence(3)), { cap: 10, silence: 1 });
  expect(segments.map(s => [s.capped, s.continues])).toEqual([
    [true, false],
    [false, false],
  ]);
});

test("two bursts are two utterances", () => {
  // The first starts the stream, so only the second has pre-roll.
  expect(feed(shapes.two()).segments.map(s => s.duration)).toEqual([1.8, 2.1]);
});

test("short peaks, as in music under the threshold, do not hold an utterance open", () => {
  // A 20 ms beat every 0.2 s for 4 s after the speech.
  const beats = Array.from({ length: 20 }, () => concat(silence(0.18), tone(0.02)));
  const { segments } = feed(concat(tone(1.5), ...beats, silence(3)), { silence: 1 });
  // The speech ends 1 s after it stops, not after the beats; the beats alone are too little speech.
  expect(segments.map(s => s.duration)).toEqual([1.5 + 0.3]);
  // Dense peaks, 60 ms in every 100 ms, count as pause too: it ends 1 s after the speech.
  const dense = Array.from({ length: 40 }, () => concat(silence(0.04), tone(0.06)));
  expect(feed(concat(tone(1.5), ...dense, silence(3)), { silence: 1 }).segments[0].duration).toBeCloseTo(1.8, 5);
  // Speech that resumes within the window still continues the utterance.
  expect(feed(concat(tone(1), silence(0.6), tone(1), silence(3)), { silence: 1 }).segments).toHaveLength(1);
});

test("too little speech is dropped", () => {
  expect(feed(concat(tone(0.1), silence(3))).segments).toHaveLength(0);
});

test("the threshold and the silence window apply", () => {
  expect(feed(shapes.speech(), { threshold: 90 }).segments).toHaveLength(0);
  expect(feed(concat(tone(1), silence(1), tone(1), silence(3)), { silence: 0.5 }).segments).toHaveLength(2);
  // Raised mid-utterance, the threshold makes the same tone quiet: the pause runs out during it.
  const { segmenter } = feed(concat(tone(1), silence(1)));
  segmenter.setThreshold(100);
  const out: Segment[] = [],
    loud = tone(2);
  for (let at = 0; at < loud.length; at += 320) out.push(...segmenter.push(loud.subarray(at, at + 320)));
  expect(out).toHaveLength(1);
  expect(segmenter.recording).toBe(false);
  // At the old threshold, the tone keeps it open.
  const kept = feed(concat(tone(1), silence(1), tone(2)));
  expect(kept.segments).toHaveLength(0);
  expect(kept.segmenter.recording).toBe(true);
});

test("the silence window can change mid-stream, and the pause shows how far it is", () => {
  let clock = 0;
  const s = new Segmenter({ threshold: 44, now: () => clock }),
    out: Segment[] = [];
  const push = (pcm: Int16Array) => {
    for (let at = 0; at < pcm.length; at += 320) {
      clock += 20;
      out.push(...s.push(pcm.subarray(at, at + 320)));
    }
  };
  push(concat(tone(1), silence(0.5)));
  expect(s.pause).toBeCloseTo(0.2, 5);
  // A shorter window ends the utterance on the next quiet frame.
  s.setTiming("silence", 0.5);
  push(silence(0.02));
  expect(out).toHaveLength(1);
  expect(s.pause).toBe(0);
});

test("pre-roll, minimum speech and burst length apply, also when changed", () => {
  // No pre-roll: the utterance starts with the speech.
  expect(feed(concat(silence(1), shapes.speech()), { pre_roll: 0 }).segments[0].duration).toBeCloseTo(1.8, 5);
  expect(feed(concat(silence(1), shapes.speech()), { pre_roll: 0.5 }).segments[0].duration).toBeCloseTo(2.3, 5);
  // 0.1 s of speech counts once the minimum is lower.
  expect(feed(concat(tone(0.1), silence(3)), { min_speech: 0.05 }).segments).toHaveLength(1);
  // With 20 ms bursts counting as speech, the beats hold the utterance open.
  const beats = Array.from({ length: 20 }, () => concat(silence(0.18), tone(0.02)));
  expect(feed(concat(tone(1.5), ...beats, silence(3)), { silence: 1, burst: 0.02 }).segments[0].duration).toBeCloseTo(
    1.5 + 4 + 0.3,
    5,
  );
  // A pre-roll shortened mid-stream keeps only the new length.
  let clock = 0;
  const s = new Segmenter({ threshold: 44, now: () => clock }),
    out: Segment[] = [];
  const push = (pcm: Int16Array) => {
    for (let at = 0; at < pcm.length; at += 320) {
      clock += 20;
      out.push(...s.push(pcm.subarray(at, at + 320)));
    }
  };
  push(silence(1));
  s.setTiming("pre_roll", 0.1);
  push(concat(tone(1), silence(3)));
  expect(out.map(s => s.duration)).toEqual([1.4]);
});

test("abort drops the utterance in progress", () => {
  const s = new Segmenter({ threshold: 44, now: () => 0 });
  const pcm = shapes.speech();
  for (let at = 0; at < 16000; at += 320) s.push(pcm.subarray(at, at + 320));
  expect(s.recording).toBe(true);
  s.abort();
  expect(s.recording).toBe(false);
  const out: Segment[] = [];
  for (let at = 16000; at < pcm.length; at += 320) out.push(...s.push(pcm.subarray(at, at + 320)));
  // Only the rest of the burst comes out: 0.5 s of it and 0.3 s of silence.
  expect(out.map(s => s.duration)).toEqual([0.8]);
});
