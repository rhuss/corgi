import { test, expect, afterEach } from "bun:test";
import { VoiceUi, problem, gaugeRow, type Options } from "./ui";
import { clock } from "./reading";
import { VoiceSession, type Utterance, type GaugeRow } from "./session";
import { Segmenter, default_timing } from "./segmenter";
import * as level from "./level";
import type { Device } from "./capture";
import * as palette from "../palette";
import * as corgiAnimation from "../corgi_animation";
import { Style } from "../palette";
import { tone } from "../../tests/fixtures/voice/make_pcm";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Recorder } from "./recorder";
import * as transcript from "./transcript";
import { Tuning } from "./tuning";

/** The text a frame leaves on a `cols` × `rows` screen. */
function screen(frame: string, cols: number, rows: number): string[] {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let x = 0,
    y = 0;
  for (let i = 0; i < frame.length;) {
    const csi = /^\x1b\[([0-9;?]*)([@-~])/.exec(frame.slice(i));
    if (csi) {
      if (csi[2] === "H") [y, x] = csi[1].split(";").map(v => Number(v || 1) - 1);
      i += csi[0].length;
      continue;
    }
    const ch = String.fromCodePoint(frame.codePointAt(i)!);
    if (y < rows && x < cols) grid[y][x] = ch;
    x++;
    i += ch.length;
  }
  return grid.map(r => r.join(""));
}
function setup(opts: Partial<Options> = {}) {
  const session = new VoiceSession({
      link: async () => {
        throw Error("NoRuntime");
      },
      transcriber: { transcribe: async () => ({ text: "" }), on: () => {} },
      segmenter: new Segmenter({ threshold: 44, now: () => 0 }),
      now: () => 0,
    }),
    calls = {
      thresholds: [] as number[],
      timings: [] as [string, number][],
      switched: [] as Device[],
      quit: 0,
      filters: 0,
    },
    ui = new VoiceUi(session, {
      target: "local",
      device: "MacBook Pro Microphone",
      model: "base.en",
      threshold: 44,
      filter: "on",
      timing: { ...default_timing },
      setTiming: (name, seconds) => calls.timings.push([name, seconds]),
      toggleFilter: async () => {
        calls.filters++;
        return calls.filters % 2 ? "off" : "on";
      },
      notices: [],
      setThreshold: pct => calls.thresholds.push(pct),
      listDevices: async () => ({
        devices: [
          { id: "0", label: "Studio Microphone", default: false },
          { id: "1", label: "MacBook Pro Microphone", default: true },
        ],
      }),
      switchDevice: d => calls.switched.push(d),
      quit: () => calls.quit++,
      ...opts,
    });
  session.link_state = "connected";
  return { session, ui, calls };
}
const said = (
  id: number,
  status: Utterance["status"],
  text: string | null,
  reason: string | null = null,
): Utterance => ({
  id,
  captured_at: 0,
  duration: 1,
  status,
  text,
  reason,
  timings: {},
  record: null,
  untyped: null,
  maybe_typed: false,
  speech_start: 0,
  speech_end: 0,
  cut_at: null,
  continues: false,
});

test("the screen shows the target, the meter and what happened", () => {
  const { session, ui } = setup({ notices: ['voice.json: "threshold" must be 0..100; using 44'] });
  session.level = 50;
  session.history = [
    { ...said(1, "delivered", "refactor the parser module"), timings: { transcribe_ms: 120, deliver_ms: 36 } },
    {
      ...said(9, "delivered", "a longer one"),
      captured_at: 3_600_000,
      timings: { transcribe_ms: 1200, deliver_ms: 50 },
    },
    said(2, "failed", "add tests", "no viewer attached"),
    said(3, "muted", null),
    said(5, "discarded", null, "no viewer"),
    said(4, "dropped", null, "empty"),
    said(6, "recording", null),
    said(7, "transcribing", null),
    said(8, "delivering", "on its way"),
  ];
  const rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[0]).toContain("Corgi Voice");
  // The note comes first; speech in progress shows there, not in the history.
  expect(rows[0].trimEnd()).toBe(" ♫ Corgi Voice");
  // Two aligned columns.
  expect(rows[2]).toBe(" Target:  local" + " ".repeat(25) + "Model:   base.en" + " ".repeat(24));
  expect(rows[3]).toStartWith(" Device:  MacBook Pro Microphone        Mode:    Listening");
  expect(rows[4]).toContain("Level:");
  expect(rows[4]).toContain("T:44");
  // No pause, no line under the meter.
  expect(rows[5].trim()).toBe("");
  // The options in two lines of aligned columns.
  expect(rows[6]).toMatch(/^ Options: silence +2\.5 s +burst +0\.1 s +post-roll 1 s +filter on/);
  expect(rows[7]).toMatch(/^ {10}pre-roll +0\.3 s +min speech +0\.2 s *$/);
  expect(rows[6].indexOf("2.5 s")).toBe(rows[7].indexOf("0.3 s"));
  expect(rows[6].indexOf("burst")).toBe(rows[7].indexOf("min speech"));
  expect(rows[6].indexOf("0.1 s")).toBe(rows[7].indexOf("0.2 s"));
  // No empty row before the separator; notices open the history.
  expect(rows[8]).toBe("─".repeat(80));
  expect(rows[9]).toContain('voice.json: "threshold" must be 0..100; using 44');
  const history = rows.slice(10, 18).join("\n");
  // A glyph, when it was said, how long the text took, then the text.
  const at = clock(0);
  expect(history).toContain(`✓ ${at} (156ms) refactor the parser module`);
  expect(history).toContain(`✓ ${clock(3_600_000)} (1.3s) a longer one`);
  expect(history).toContain(`✗ ${at} add tests · failed: no viewer attached`);
  // Muting drops speech on purpose; that needs no row. Other discards show why.
  expect(history).toContain(`○ ${at} discarded (no viewer)`);
  expect(history.match(/discarded/g)).toHaveLength(1);
  expect(history).not.toContain("listening…");
  expect(history).not.toContain("transcribing");
  expect(history).toContain(`→ ${at} on its way`);
  expect(history).not.toContain("empty");
  expect(rows[19]).toContain(" m  mute");
  expect(rows[19]).toContain(" q  quit");
});

test("muted, unavailable and disconnected states say so", () => {
  const { session, ui } = setup();
  session.muted = true;
  expect(screen(ui.draw(80, 20), 80, 20)[0]).toStartWith(" ♫ Corgi Voice");
  expect(screen(ui.draw(80, 20), 80, 20)[3]).toContain("Mode:    MUTED");
  session.setAvailable(false, "mic_busy");
  let rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[0]).toStartWith(" ○ Corgi Voice");
  // A voice that cannot listen counts as muted, as in the sidebar.
  expect(rows[3]).toContain("Mode:    MUTED");
  expect(rows[9]).toContain("The microphone is in use by another program");
  session.setAvailable(true, null);
  session.link_state = "lost";
  rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[9]).toContain("Lost the connection to local; retrying every 5 s");
  expect(screen(ui.draw(20, 5), 20, 5)[0]).toContain("Make this window");
  expect(screen(ui.draw(80, 13), 80, 13)[0]).toContain("Make this window");
});

test("the mode is MUTED or Listening; the note adds a missing viewer and what speech is doing", () => {
  const { session, ui } = setup();
  const shown = () => {
    const frame = ui.draw(80, 20),
      rows = screen(frame, 80, 20);
    return { note: rows[0][1], mode: rows[3].slice(48).trim(), frame };
  };
  const green = palette.colors.accent;
  expect(shown()).toMatchObject({ note: "♫", mode: "Listening" });
  expect(shown().frame).toContain(palette.fgRgb(palette.mix(green, palette.colors.bg, 35)) + "♫");
  session.history = [said(1, "transcribing", null)];
  expect(shown()).toMatchObject({ note: "♫", mode: "Listening" });
  session.history.push(said(2, "recording", null));
  expect(shown()).toMatchObject({ note: "♫", mode: "Listening" });
  expect(shown().frame).toContain(palette.fgRgb(green) + "♫");
  session.history = [];
  const grey = new Style({ fg: "muted", bg: "bg" }).sgr() + "♫";
  // Not connected to the runtime: the note stays grey, whatever the link is doing.
  for (const state of ["connecting", "lost", "refused"] as const) {
    session.link_state = state;
    expect(shown()).toMatchObject({ note: "♫", mode: "Listening" });
    expect(shown().frame).toContain(grey);
  }
  session.link_state = "connected";
  session.viewer = false;
  expect(shown()).toMatchObject({ note: "♫", mode: "Listening" });
  expect(shown().frame).toContain(grey);
  expect(screen(shown().frame, 80, 20)[9]).toContain("No Corgi window is attached");
  // Muted: the same note, grey, whether or not a viewer is attached.
  session.muted = true;
  expect(shown()).toMatchObject({ note: "♫", mode: "MUTED" });
  expect(shown().frame).toContain(grey);
  session.viewer = true;
  expect(shown()).toMatchObject({ note: "♫", mode: "MUTED" });
  expect(shown().frame).toContain(grey);
  expect(shown().frame).toContain(new Style({ fg: "hot", bg: "bg", bold: true }).sgr() + "MUTED");
});

test("a click on the note or the mode mutes and unmutes", () => {
  const { session, ui } = setup();
  ui.draw(80, 20);
  // SGR mouse reports are 1-based: the note sits in column 2, the mode from column 50.
  ui.input("\x1b[<0;2;1M");
  expect(session.muted).toBe(true);
  ui.draw(80, 20);
  ui.input("\x1b[<0;50;4M");
  expect(session.muted).toBe(false);
  ui.input("\x1b[<0;10;4M");
  expect(session.muted).toBe(false);
});

test("muting does not shift the keys in the footer", () => {
  const { session, ui } = setup();
  const footer = () => screen(ui.draw(80, 20), 80, 20)[19];
  const before = footer();
  session.muted = true;
  const after = footer();
  expect(after).toContain(" unmute");
  expect(after.indexOf(" q ")).toBe(before.indexOf(" q "));
  expect(after.indexOf(" + - ")).toBe(before.indexOf(" + - "));
});

test("a denied microphone names the setting that fixes it", () => {
  const { session } = setup();
  session.setAvailable(false, "mic_denied");
  expect(problem(session, "ghostty", "darwin")).toBe(
    "Microphone access denied: allow ghostty in System Settings › Privacy & Security › Microphone",
  );
  expect(problem(session, "", "darwin")).toContain("allow your terminal in");
  expect(problem(session, "ghostty", "linux")).toBe("Microphone access denied");
});

test("+ and - move the threshold by 2 within 0..100", () => {
  const { ui, calls } = setup();
  ui.input("+");
  ui.input("-");
  ui.input("-");
  expect(calls.thresholds).toEqual([46, 44, 42]);
  ui.threshold = 99;
  ui.input("+");
  ui.input("+");
  expect(ui.threshold).toBe(100);
  expect(screen(ui.draw(80, 20), 80, 20)[4]).toContain("T:100");
});

test("the meter fills braille dots in quarter cells, dimmed under the threshold", () => {
  const { session, ui } = setup();
  // The meter starts after the 9-cell label at column 1.
  const meter = () => screen(ui.draw(80, 20), 80, 20)[4].slice(10, 30);
  const mark = new Style({ fg: "warm", bg: "bg", bold: true }).sgr(),
    green = palette.colors.accent;
  // 20 cells; the threshold 44 is a solid warm bar in cell 9, whatever the level.
  session.level = 0;
  expect(meter()).toBe(" ".repeat(9) + "┃" + " ".repeat(10));
  expect(ui.draw(80, 20)).toContain(mark + "┃");
  // 30 fills six cells, dimmed: the level is under the threshold.
  session.level = 30;
  expect(meter()).toBe("⣿".repeat(6) + " ".repeat(3) + "┃" + " ".repeat(10));
  expect(ui.draw(80, 20)).toContain(palette.fgRgb(palette.mix(green, palette.colors.bg, 55)) + "⣿");
  // 52.5 fills 10.5 cells in full color; the bar stays warm.
  session.level = 52.5;
  expect(meter()).toBe("⣿".repeat(9) + "┃" + "⣤" + " ".repeat(9));
  expect(ui.draw(80, 20)).toContain(mark + "┃");
  // The filled cells run from the accent to hot.
  session.level = 100;
  const frame = ui.draw(80, 20);
  expect(frame).toContain(palette.fgRgb(green) + "⣿");
  expect(frame).toContain(palette.fgRgb(palette.colors.hot) + "⣿");
  // Muted, the same cells turn grey at the same brightness.
  session.muted = true;
  const muted = ui.draw(80, 20),
    [r, g, b] = palette.colors.hot,
    y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  expect(muted).toContain(palette.fgRgb([y, y, y]) + "⣿");
  expect(muted).not.toContain(palette.fgRgb(palette.colors.hot) + "⣿");
  expect(muted).toContain(mark + "┃");
});

test("outside the reading view the wheel moves the threshold anywhere in the window", () => {
  const { ui, calls, session } = setup();
  session.history = Array.from({ length: 40 }, (_, i) => said(i + 1, "delivered", `line ${i + 1}`));
  ui.input("\x1b[<64;10;3M");
  ui.input("\x1b[<65;10;3M\x1b[<65;10;3M");
  ui.input("\x1b[<64;40;12M");
  expect(calls.thresholds).toEqual([46, 44, 42, 44]);
  expect(ui.scroll).toBe(0);
});

test("PgUp and PgDn page through the history", () => {
  const { session, ui } = setup();
  session.history = Array.from({ length: 40 }, (_, i) => said(i + 1, "delivered", `line ${i + 1}`));
  let rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[17]).toContain("line 40");
  // A log, scrolled with the keys: no scroll bar.
  expect(rows.slice(9, 18).some(r => r.endsWith("┃"))).toBe(false);
  ui.input("\x1b[5~", 20);
  rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows.join("\n")).not.toContain("line 40");
  expect(rows[17]).toContain("line 32");
  ui.input("\x1b[6~", 20);
  expect(screen(ui.draw(80, 20), 80, 20)[17]).toContain("line 40");
});

test("vi keys move through the history", () => {
  const { session, ui } = setup();
  session.history = Array.from({ length: 40 }, (_, i) => said(i + 1, "delivered", `line ${i + 1}`));
  const newest = () => {
    ui.draw(80, 20);
    return screen(ui.draw(80, 20), 80, 20)[17].match(/line \d+/)![0];
  };
  ui.input("k", 20);
  expect(newest()).toBe("line 39");
  ui.input("\x1b[A", 20);
  expect(newest()).toBe("line 38");
  ui.input("j", 20);
  expect(newest()).toBe("line 39");
  // Half a page is four rows here, a page eight.
  ui.input("\x15", 20);
  expect(newest()).toBe("line 35");
  ui.input("\x04", 20);
  expect(newest()).toBe("line 39");
  ui.input("\x02", 20);
  expect(newest()).toBe("line 31");
  ui.input("\x06", 20);
  expect(newest()).toBe("line 39");
  ui.input("g", 20);
  expect(newest()).toBe("line 9");
  ui.input("G", 20);
  expect(newest()).toBe("line 40");
});

/** Clicks the 0-based cell where `text` first shows on row `y`. */
function click(ui: VoiceUi, rows: string[], y: number, text: string) {
  const x = rows[y].indexOf(text);
  expect(x).toBeGreaterThanOrEqual(0);
  ui.input(`\x1b[<0;${x + 1};${y + 1}M`);
}

test("a click on a timing opens its menu; keys or a click pick a value", () => {
  const { ui, calls } = setup();
  let rows = screen(ui.draw(80, 20), 80, 20);
  click(ui, rows, 6, "2.5 s");
  rows = screen(ui.draw(80, 20), 80, 20);
  // The menu opens below the value with the current one chosen.
  expect(rows.join("\n")).toContain("❯ 2.5 s");
  expect(rows[7]).toContain("╭");
  ui.input("\x1b[B");
  ui.input("\r");
  expect(ui.menu).toBeNull();
  expect(calls.timings).toEqual([["silence", 3]]);
  rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[6]).toMatch(/silence +3 s /);
  // A click on the name opens the menu too, and a click on a value picks it.
  click(ui, rows, 7, "pre-roll");
  rows = screen(ui.draw(80, 20), 80, 20);
  const y = rows.findIndex(r => r.includes("  0.5 s"));
  click(ui, rows, y, "0.5 s");
  expect(calls.timings.at(-1)).toEqual(["pre_roll", 0.5]);
  expect(ui.timing.pre_roll).toBe(0.5);
  // A click elsewhere, or Esc, closes it without a change.
  click(ui, screen(ui.draw(80, 20), 80, 20), 7, "min speech");
  expect(ui.menu?.name).toBe("min_speech");
  ui.input("\x1b[<0;70;15M");
  expect(ui.menu).toBeNull();
  click(ui, screen(ui.draw(80, 20), 80, 20), 6, "burst");
  // The wheel and the keys do nothing else while it is open.
  ui.input("\x1b[<64;10;3M");
  ui.input("m");
  ui.input("\x1b");
  expect(ui.menu).toBeNull();
  expect(calls.timings).toHaveLength(2);
  expect(calls.thresholds).toEqual([]);
  expect(ui.session.muted).toBe(false);
});

test("a timing from voice.json joins its menu's values", () => {
  const { ui } = setup({ timing: { ...default_timing, silence: 2.2 } });
  click(ui, screen(ui.draw(80, 20), 80, 20), 6, "2.2 s");
  const rows = screen(ui.draw(80, 20), 80, 20).join("\n");
  expect(rows).toContain("❯ 2.2 s");
  expect(rows.indexOf("2 s")).toBeLessThan(rows.indexOf("❯ 2.2 s"));
});

test("post-roll sits between burst and filter; its menu ends in whole pause", () => {
  const { ui, calls } = setup();
  let rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[6].indexOf("post-roll")).toBe(48);
  expect(rows[6].indexOf("filter")).toBe(66);
  click(ui, rows, 6, "post-roll");
  expect(ui.menu?.values).toEqual([0.3, 0.5, 0.75, 1, 1.5, 2, Infinity]);
  rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows.join("\n")).toContain("❯ 1 s");
  // The box is as wide as its longest label.
  const last = rows.findIndex(r => r.includes("whole pause"));
  expect(rows[last]).toMatch(/│ {3}whole pause │/);
  expect(rows[last + 1]).toContain("╰" + "─".repeat(15) + "╯");
  click(ui, rows, last, "whole pause");
  expect(calls.timings).toEqual([["post_roll", Infinity]]);
  // The filter's padding follows without a server restart.
  expect(calls.filters).toBe(0);
  expect(ui.timing.post_roll).toBe(Infinity);
  // On the line it reads "pause".
  expect(screen(ui.draw(80, 20), 80, 20)[6]).toMatch(/post-roll pause +filter on/);
});

test("a post-roll from voice.json joins the menu; whole pause starts as pause", () => {
  const odd = setup({ timing: { ...default_timing, post_roll: 1.2 } });
  let rows = screen(odd.ui.draw(80, 20), 80, 20);
  expect(rows[6]).toMatch(/post-roll 1\.2 s +filter on/);
  click(odd.ui, rows, 6, "post-roll");
  expect(odd.ui.menu?.values).toEqual([0.3, 0.5, 0.75, 1, 1.2, 1.5, 2, Infinity]);
  expect(screen(odd.ui.draw(80, 20), 80, 20).join("\n")).toContain("❯ 1.2 s");
  const whole = setup({ timing: { ...default_timing, post_roll: Infinity } });
  rows = screen(whole.ui.draw(80, 20), 80, 20);
  expect(rows[6]).toMatch(/post-roll pause +filter on/);
  click(whole.ui, rows, 6, "pause");
  expect(screen(whole.ui.draw(80, 20), 80, 20).join("\n")).toContain("❯ whole pause");
});

test("a narrow window clips the options line without disturbing the rows around it", () => {
  const { ui } = setup(),
    rows = screen(ui.draw(70, 20), 70, 20);
  expect(rows[6]).toMatch(/^ Options: silence +2\.5 s +burst +0\.1 s +post-roll 1 s +fil…$/);
  expect(rows[7]).toMatch(/^ {10}pre-roll +0\.3 s +min speech +0\.2 s *$/);
  expect(rows[8]).toBe("─".repeat(70));
  // Nothing is written past the last column, where it would wrap.
  for (const row of screen(ui.draw(70, 20), 100, 20)) expect(row.slice(70).trim()).toBe("");
  // The filter's state shows from 75 columns.
  expect(screen(ui.draw(75, 20), 75, 20)[6]).toMatch(/filter on$/);
});

test("? explains the options in an overlay that scrolls when it does not fit", () => {
  const { ui, calls } = setup();
  ui.input("?");
  let rows = screen(ui.draw(80, 60), 80, 60).join("\n");
  expect(rows).toContain("╭─ Options");
  for (const name of ["threshold", "silence", "burst", "post-roll", "filter", "pre-roll", "min speech"])
    expect(rows).toContain(name);
  expect(rows).toContain("Audio kept after the last loud stretch, so a quiet sentence");
  // Its cost: more background sound, which Whisper can turn into a stray word.
  expect(rows).toContain("background sound, which can become a stray word");
  expect(rows.indexOf("post-roll")).toBeGreaterThan(rows.indexOf("burst "));
  expect(rows).toContain("How loud a sound must be to count as speech");
  expect(rows).toContain("? or esc close");
  // Keys under it do nothing while it is open.
  ui.input("+");
  ui.input("m");
  expect(calls.thresholds).toEqual([]);
  expect(ui.session.muted).toBe(false);
  ui.input("?");
  expect(ui.help).toBeNull();
  // On a small screen it scrolls.
  ui.input("?");
  rows = screen(ui.draw(80, 20), 80, 20).join("\n");
  expect(rows).toContain("↑↓ scroll");
  expect(rows).not.toContain("min speech");
  for (let i = 0; i < 30; i++) ui.input("j");
  rows = screen(ui.draw(80, 20), 80, 20).join("\n");
  expect(rows).toContain("min speech");
  ui.input("\x1b");
  expect(ui.help).toBeNull();
  // Any click closes it too.
  ui.input("?");
  ui.input("\x1b[<0;2;1M");
  expect(ui.help).toBeNull();
  expect(ui.session.muted).toBe(false);
});

test("a pause grows a line under the meter", () => {
  const { session, ui } = setup();
  session.pause = 0.5;
  expect(screen(ui.draw(80, 20), 80, 20)[5]).toBe(" ".repeat(10) + "─".repeat(10) + " ".repeat(60));
  // In the separators' grey, not the accent.
  expect(ui.draw(80, 20)).toContain(new Style({ fg: "line", bg: "bg" }).sgr() + "─".repeat(10));
});

test("f switches the speech filter, one restart at a time", async () => {
  const { ui, calls } = setup();
  ui.input("f");
  // The server restarts in the meantime, and a second press waits for it.
  // The filter's value starts at cell 73; this one needs 83 columns.
  expect(screen(ui.draw(90, 20), 90, 20)[6]).toContain("filter switching…");
  ui.input("f");
  await Bun.sleep(0);
  expect(calls.filters).toBe(1);
  expect(screen(ui.draw(80, 20), 80, 20)[6]).toContain("filter off");
  // A click on it switches it too.
  click(ui, screen(ui.draw(80, 20), 80, 20), 6, "filter");
  await Bun.sleep(0);
  expect(ui.filter).toBe("on");
  // Not installed, there is nothing to switch.
  const missing = setup({ filter: "not installed" });
  missing.ui.input("f");
  expect(missing.calls.filters).toBe(0);
});

test("the target names the pane the next text goes to", () => {
  const { session, ui } = setup({ filter: "not installed" });
  session.focus = "dictation";
  const rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[2]).toContain("Target:  local → dictation");
  // On the options line it reads "missing", which fits 80 columns.
  expect(rows[6]).toMatch(/filter missing$/);
  // A long name is cut to its column, leaving the second one in place.
  session.focus = "a pane with a very long title indeed";
  ui.device = "USB Audio Interface with a very long name";
  const long = screen(ui.draw(80, 20), 80, 20);
  expect(long[2]).toMatch(/^ Target: {2}local → a pane with a .{2,8}… +Model: {3}base\.en/);
  expect(long[3]).toMatch(/^ Device: {2}USB Audio Interface .{2,8}… +Mode: {4}Listening/);
  expect(long[2].indexOf("Model:")).toBe(rows[2].indexOf("Model:"));
});

test("the device picker lists microphones and switches to one", async () => {
  const { ui, calls } = setup();
  ui.input("d");
  expect(screen(ui.draw(80, 20), 80, 20).join("\n")).toContain("Listing microphones…");
  await Bun.sleep(0);
  const rows = screen(ui.draw(80, 20), 80, 20).join("\n");
  expect(rows).toContain("Studio Microphone");
  expect(rows).toContain("❯ MacBook Pro Microphone  (default)");
  ui.input("\x1b[A");
  ui.input("\r");
  expect(calls.switched.map(d => d.id)).toEqual(["0"]);
  expect(ui.picker).toBeNull();
  expect(screen(ui.draw(80, 20), 80, 20)[3]).toContain("Device:  Studio Microphone");
  ui.input("d");
  ui.input("\x1b");
  expect(ui.picker).toBeNull();
});

test("the device picker starts on the microphone given by its ID", async () => {
  const { ui, calls } = setup({ device: "0" });
  ui.input("d");
  await Bun.sleep(0);
  expect(screen(ui.draw(80, 20), 80, 20).join("\n")).toContain("❯ Studio Microphone");
  ui.input("\r");
  expect(calls.switched.map(d => d.id)).toEqual(["0"]);
});

test("the device picker scrolls to keep the chosen microphone in view", async () => {
  const devices = Array.from({ length: 12 }, (_, i) => ({ id: String(i), label: `Mic ${i}`, default: i === 0 }));
  const { ui, calls } = setup({ listDevices: async () => ({ devices }) });
  ui.input("d");
  await Bun.sleep(0);
  // On 14 rows the picker shows seven devices.
  for (let i = 0; i < 11; i++) ui.input("\x1b[B", 14);
  const rows = screen(ui.draw(80, 14), 80, 14).join("\n");
  expect(rows).toContain("❯ Mic 11");
  expect(rows).not.toContain("Mic 4");
  ui.input("\r", 14);
  expect(calls.switched.map(d => d.id)).toEqual(["11"]);
});

test("a window narrower than the level row asks to be made bigger", () => {
  const { ui } = setup();
  expect(screen(ui.draw(36, 20), 36, 20)[0]).toContain("Make this window bigger");
  expect(screen(ui.draw(37, 20), 37, 20)[4]).toContain("T:44");
});

test("m mutes and q or ctrl+c quits", () => {
  const { session, ui, calls } = setup();
  ui.input("m");
  expect(session.muted).toBe(true);
  expect(screen(ui.draw(80, 20), 80, 20)[19]).toContain(" m  unmute");
  ui.input("m");
  expect(session.muted).toBe(false);
  ui.input("q");
  ui.input("\x03");
  expect(calls.quit).toBe(2);
});

/** Feeds the session `seconds` of a tone at threshold-scale level `pct`, a frame at a time. */
function hum(session: VoiceSession, pct: number, seconds: number) {
  const pcm = tone(seconds, level.percentToRms(pct));
  for (let at = 0; at < pcm.length; at += 320) session.frame(pcm.subarray(at, at + 320));
}

test("t starts a gauge: the corgi sniffs under the meter, a tick marks the loudest, T: counts down", () => {
  const { session, ui } = setup();
  ui.input("t");
  expect(session.gauge).not.toBeNull();
  let rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[4]).toContain("T:10s");
  // The meter starts at column 10; the corgi's nose is under its first cell.
  expect(rows[5].slice(7, 13)).toBe(corgiAnimation.gaugeScene(20, 0, 0).sprite);
  hum(session, 61.5, 2.5);
  rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[4]).toContain("T:8s");
  // A quarter of the way, its sniff frame from the 125 frames heard.
  const corgi = corgiAnimation.gaugeScene(20, 0.25, 2500);
  expect(rows[5].slice(10 + corgi.x - 3, 10 + corgi.x + 3)).toBe(corgi.sprite);
  // The marker stays at 44, cell 9; the tick marks 61.5, cell 12.
  expect(rows[4][10 + 9]).toBe("┃");
  expect(rows[4][10 + 12]).toBe("│");
  hum(session, 61.5, 7.5);
  expect(session.gauge).toBeNull();
  rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[5].trim()).toBe("");
  expect(rows[4]).not.toContain("│");
});

test("the gauge's tick stays at the loudest level heard, not the level now", () => {
  const { session, ui } = setup();
  ui.input("t");
  hum(session, 70.5, 1);
  hum(session, 50.5, 2);
  expect(session.gauge?.loudest).toBeCloseTo(level.rmsToPercent(level.rms(tone(0.02, level.percentToRms(70.5)))), 5);
  const meter = screen(ui.draw(80, 20), 80, 20)[4];
  // 70.5 is cell 14; the level, now 50.5, fills ten cells.
  expect(meter.indexOf("│") - 10).toBe(14);
});

test("while a gauge listens only esc, q, ctrl+c, ? and m act", async () => {
  const { session, ui, calls } = setup();
  ui.input("t");
  const rows = screen(ui.draw(80, 20), 80, 20);
  for (const ignored of ["+", "-", "\x1b[<64;10;3M", "d", "f", "j", "k", "t"]) ui.input(ignored);
  // A click on an option opens no menu.
  click(ui, rows, 6, "2.5 s");
  click(ui, rows, 6, "filter");
  await Bun.sleep(0);
  expect([calls.thresholds, calls.filters, calls.quit, ui.picker, ui.menu]).toEqual([[], 0, 0, null, null]);
  expect(session.gauge?.frames).toEqual([]);
  // m, or a click on the note, mutes and unmutes; the gauge goes on.
  ui.input("m");
  expect(session.muted).toBe(true);
  ui.input("\x1b[<0;2;1M");
  expect(session.muted).toBe(false);
  // With the help open, esc, q and ? close the help first.
  for (const close of ["\x1b", "q", "?"]) {
    ui.input("?");
    expect(ui.help).not.toBeNull();
    ui.input(close);
    expect(ui.help).toBeNull();
    expect(session.gauge).not.toBeNull();
  }
  // Without it, each cancels the gauge, and none quits.
  for (const cancel of ["\x1b", "q", "\x03"]) {
    ui.input("t");
    expect(session.gauge).not.toBeNull();
    ui.input(cancel);
    expect(session.gauge).toBeNull();
  }
  expect([calls.quit, session.gauges, ui.threshold]).toEqual([0, [], 44]);
});

test("t without a microphone starts nothing; the problem is already on screen", () => {
  const { session, ui } = setup();
  session.setAvailable(false, "mic_missing");
  ui.input("t");
  expect(session.gauge).toBeNull();
  const rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[9]).toContain("No microphone found: press d");
  expect(rows[19]).toContain(" q  quit");
});

test("the help lists the gauge right after the threshold", () => {
  const { ui } = setup();
  ui.input("?");
  const rows = screen(ui.draw(80, 40), 80, 40).join("\n");
  expect(rows).toContain("Press t and stay quiet for 10 s");
  expect(rows).toContain("Esc cancels.");
  expect(rows.indexOf("gauge")).toBeGreaterThan(rows.indexOf("threshold"));
  expect(rows.indexOf("gauge")).toBeLessThan(rows.indexOf("silence"));
});

test("the footer has t gauge after the threshold keys, and esc cancel during a gauge", () => {
  const { session, ui } = setup();
  const footer = (cols = 100) => screen(ui.draw(cols, 20), cols, 20)[19];
  expect(footer()).toContain(" + -  threshold   t  gauge   f  filter   d  device");
  // At 80 columns it pushes d device off; a missing microphone still names d.
  expect(footer(80)).toMatch(/ f {2}filter\s*$/);
  session.setAvailable(false, "mic_missing");
  expect(screen(ui.draw(80, 20), 80, 20)[9]).toContain("press d");
  session.setAvailable(true, null);
  ui.input("t");
  const during = footer();
  expect(during).toContain(" m  mute");
  expect(during).toContain(" esc  cancel");
  expect(during).toContain(" ?  help");
  for (const gone of [" q ", "threshold", "gauge", "filter"]) expect(during).not.toContain(gone);
  ui.input("\x1b");
  expect(footer()).toContain(" q  quit");
});

test("a gauged threshold applies at once, and the marker glides there a cell every 50 ms", () => {
  let now = 1000;
  const { session, ui, calls } = setup({ now: () => now });
  ui.input("t");
  hum(session, 55.5, 10);
  expect(session.gauges.map(g => g.threshold)).toEqual([58]);
  const shown = () => {
    const row = screen(ui.draw(80, 20), 80, 20)[4];
    return [row.indexOf("┃") - 10, row.match(/T:(\d+)/)![1]];
  };
  // From 44 at cell 9 to 58 at cell 12, the number counting along.
  expect(shown()).toEqual([9, "44"]);
  expect(ui.threshold).toBe(58);
  const steps: unknown[] = [];
  for (let i = 0; i < 4; i++) {
    now += 50;
    steps.push(shown());
  }
  expect(steps).toEqual([
    [10, "49"],
    [11, "53"],
    [12, "58"],
    [12, "58"],
  ]);
  // The gauge sets the session's threshold itself; the UI saves nothing.
  expect(calls.thresholds).toEqual([]);
});

test("+ right after a gauge's result starts from the new threshold", () => {
  const { session, ui, calls } = setup();
  ui.input("t");
  hum(session, 55.5, 10);
  ui.input("+");
  expect(calls.thresholds).toEqual([60]);
  expect(screen(ui.draw(80, 20), 80, 20)[4]).toContain("T:60");
});

test("gauge rows join the history by time, each saying what it did", () => {
  const { session, ui } = setup();
  session.history = [
    { ...said(1, "delivered", "before"), captured_at: 0 },
    { ...said(2, "delivered", "after"), captured_at: 2000 },
  ];
  session.gauges = [{ at: 1000, old: 44, threshold: 58, loudest: 55.4, outcome: "applied", took_ms: 10012 }];
  const history = screen(ui.draw(80, 20), 80, 20)
    .slice(9, 18)
    .map(r => r.trim())
    .filter(r => r);
  expect(history).toEqual([
    `✓ ${clock(0)} before`,
    `┃ ${clock(1000)} threshold 44 → 58 (gauged)`,
    `✓ ${clock(2000)} after`,
  ]);
  const row = (outcome: GaugeRow["outcome"], threshold = 58) =>
      gaugeRow({ at: 0, old: 44, threshold, loudest: 55, outcome, took_ms: 0 }),
    text = new Style({ fg: "text", bg: "bg" }).sgr(),
    warm = new Style({ fg: "warm", bg: "bg" }).sgr(),
    hot = new Style({ fg: "hot", bg: "bg" }).sgr();
  expect(row("applied")).toMatchObject({ label: "threshold 44 → 58 (gauged)", style: text });
  expect(row("applied_quiet_speech")).toMatchObject({
    label: "threshold 44 → 58 (gauged; music ≈ your speech, turn it down)",
    style: warm,
  });
  expect(row("no_speech_to_compare")).toMatchObject({
    label: "threshold 44 → 58 (gauged; no speech yet to compare)",
    style: text,
  });
  expect(row("too_loud", 44)).toMatchObject({ label: "threshold stays 44 (music too loud to gauge)", style: warm });
  expect(row("mic_failed", 44)).toMatchObject({
    label: "threshold stays 44 (gauge stopped: microphone failed)",
    style: hot,
  });
});

test("the gauge's warning row fits 80 columns whole, even with three-digit thresholds", () => {
  const { session, ui } = setup();
  session.gauges = [
    { at: 0, old: 44, threshold: 58, loudest: 55, outcome: "applied_quiet_speech", took_ms: 10000 },
    { at: 1000, old: 100, threshold: 100, loudest: 97, outcome: "applied_quiet_speech", took_ms: 10000 },
  ];
  const rows = screen(ui.draw(80, 20), 80, 20).join("\n");
  expect(rows).toContain(`┃ ${clock(0)} threshold 44 → 58 (gauged; music ≈ your speech, turn it down)`);
  expect(rows).toContain(`┃ ${clock(1000)} threshold 100 → 100 (gauged; music ≈ your speech, turn it down)`);
  expect(rows).not.toContain("…");
});

test("the status line names every problem that keeps voice from listening", () => {
  const { session, ui } = setup(),
    status = (cols = 80) => screen(ui.draw(cols, 20), cols, 20)[9].trim();
  session.setAvailable(false, "mic_missing");
  expect(status()).toBe("No microphone found: press d to pick another");
  session.setAvailable(true, null);
  session.server = "crashed";
  expect(status()).toBe("The Whisper server stopped: press f for a fresh one, or restart voice mode");
  // Both: the microphone comes first, as it is why t starts no gauge.
  session.setAvailable(false, "mic_missing");
  const both =
    "No microphone found, and the Whisper server stopped: press d to pick another; press f for a fresh server, or restart voice mode";
  expect(problem(session, "ghostty", "darwin")).toBe(both);
  ui.input("t");
  expect(session.gauge).toBeNull();
  expect(status(140)).toBe(both);
  // Clipped like any row; at 80 columns both are still named.
  expect(status()).toStartWith("No microphone found, and the Whisper server stopped: press d to pick another");
  expect(status()).toEndWith("…");
  session.setAvailable(false, "mic_busy");
  expect(status()).toStartWith("The microphone is in use by another program, and the Whisper server stopped:");
  session.setAvailable(false, "mic_denied");
  expect(problem(session, "ghostty", "darwin")).toBe(
    "Microphone access denied, and the Whisper server stopped: allow ghostty in System Settings › Privacy & Security › Microphone; press f for a fresh server, or restart voice mode",
  );
  expect(problem(session, "ghostty", "linux")).toBe(
    "Microphone access denied, and the Whisper server stopped: press f for a fresh server, or restart voice mode",
  );
});

test("at the smallest size the gauge's countdown, corgi and result still show", () => {
  const { session, ui } = setup();
  ui.input("t");
  hum(session, 61.5, 9.9);
  let rows = screen(ui.draw(37, 20), 37, 20);
  expect(rows[4]).toContain("T:1s");
  // At the last cell, the corgi still fits.
  expect(rows[5]).toContain(corgiAnimation.gaugeScene(20, 0.99, 9900).sprite);
  hum(session, 61.5, 0.1);
  rows = screen(ui.draw(37, 20), 37, 20);
  expect(rows[4]).toMatch(/T:\d\d/);
  expect(rows.join("\n")).toContain("threshold 44 → 64");
  // Nothing past the last column.
  for (const row of screen(ui.draw(37, 20), 60, 20)) expect(row.slice(37).trim()).toBe("");
});

test("at the smallest window, 37 by 14 with a notice, the countdown and result show", () => {
  const { session, ui } = setup({ notices: ["The speech filter is not installed"] });
  ui.input("t");
  hum(session, 61.5, 9.9);
  let rows = screen(ui.draw(37, 14), 37, 14);
  // The notice takes the first history row.
  expect(rows[9]).toContain("The speech filter");
  expect(rows[4]).toContain("T:1s");
  hum(session, 61.5, 0.1);
  rows = screen(ui.draw(37, 14), 37, 14);
  expect(rows[4]).toMatch(/T:\d\d/);
  expect(rows.join("\n")).toContain("threshold 44 → 64");
});

const folders: string[] = [],
  recorders: Recorder[] = [];
afterEach(() => {
  // Close every transcript a test left open before its folder goes.
  for (const r of recorders.splice(0)) r.finish();
  for (const d of folders.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A voice window that records into a fresh folder, as main.ts wires it. */
function recording(opts: Partial<Options> = {}, real?: Tuning) {
  const folder = mkdtempSync(join(tmpdir(), "corgi-ui-")),
    tuning = real ?? ({ pause_break: 2, begin: () => {}, end: () => {} } as unknown as Tuning),
    recorder = new Recorder({ tuning, now: () => 0 }),
    started: string[] = [];
  folders.push(folder);
  recorders.push(recorder);
  let stops = 0;
  const made = setup({
    recorder,
    folder,
    resolveName: (name, dir) => transcript.resolve(name, dir, "/home/me"),
    startRecording: path => {
      started.push(path);
      return recorder.start(path);
    },
    stopRecording: () => {
      stops++;
      void recorder.stop();
    },
    ...opts,
  });
  return { ...made, recorder, folder, started, stops: () => stops };
}

/** Ctrl+A and Ctrl+K: empties the file name, suggestion and all. */
const clear = "\x01\x0b";
/** The line under the dialog's title, before a frame cuts it to fit: temp
 * folders can be longer than the dialog is wide. */
function hint(ui: VoiceUi): string | undefined {
  ui.draw(80, 20);
  return ui.prompt?.dialog.note?.text;
}
/** The whole screen, wide enough for a temp folder's paths. */
const wide = (ui: VoiceUi) => screen(ui.draw(200, 20), 200, 20).join("\n");

test("r opens the New workspace dialog for a file name in the transcript folder, the caret after the date", () => {
  const { ui, folder, started } = recording();
  ui.input("r");
  const d = ui.prompt!.dialog;
  expect(d.name()).toMatch(/^\d{4}-\d\d-\d\d-\.txt$/);
  expect(d.cursor).toBe(d.len - ".txt".length);
  expect(d.selected).toBe(false);
  expect(d.browser.folder()).toBe(folder);
  let rows = screen(ui.draw(80, 20), 80, 20).join("\n");
  expect(rows).toContain("Record a transcript");
  expect(rows).toContain("File name");
  expect(rows).toContain("Folder");
  expect(rows).toContain("record");
  expect(rows).toContain("out / in");
  // The voice window hides the terminal's cursor, so the field draws its own caret.
  expect(ui.draw(80, 20)).toContain("\x1b[7m.");
  // Typing goes in between the date and the extension.
  ui.input("standupX\x7f");
  const name = d.name();
  expect(name).toMatch(/^\d{4}-\d\d-\d\d-standup\.txt$/);
  expect(hint(ui)).toBe(join(folder, name));
  ui.input(clear);
  expect(d.name()).toBe("");
  rows = screen(ui.draw(80, 20), 80, 20).join("\n");
  expect(rows).toContain("name is empty");
  // Enter on a refused name does nothing; Esc cancels without a file.
  ui.input("\r");
  expect(ui.prompt).not.toBeNull();
  ui.input("../x.txt");
  expect(screen(ui.draw(80, 20), 80, 20).join("\n")).toContain("no .. in the name; pick the folder below");
  ui.input("\x1b");
  expect(ui.prompt).toBeNull();
  expect(started).toEqual([]);
});

test("the dialog's folder browser picks the folder, and the next recording opens there", () => {
  const { ui, folder, started, recorder } = recording();
  mkdirSync(join(folder, "calls"));
  ui.input("r");
  // Tab to the folder field; Down highlights its first folder and writes it in.
  ui.input("\t");
  ui.input("\x1b[B");
  const d = ui.prompt!.dialog;
  expect(d.browser.focused).toBe(true);
  expect(d.browser.folder()).toBe(join(folder, "calls"));
  expect(screen(ui.draw(80, 20), 80, 20).join("\n")).toContain("calls");
  const name = d.name();
  ui.input("\r");
  expect(started).toEqual([join(folder, "calls", name)]);
  void recorder.stop();
  ui.input("r");
  expect(ui.prompt!.dialog.browser.folder()).toBe(join(folder, "calls"));
});

test("a short window keeps the dialog's folder: fewer folders, then the folder field alone", () => {
  const { ui, folder } = recording();
  mkdirSync(join(folder, "calls"));
  ui.input("r");
  const d = ui.prompt!.dialog,
    tail = folder.slice(-12);
  // Two rows short of three folders: one shows.
  let rows = screen(ui.draw(80, 16), 80, 16).join("\n");
  expect(rows).toContain("Folder");
  expect(rows).toContain("calls");
  // The smallest voice window: no list, but the field still takes a folder.
  rows = screen(ui.draw(80, 14), 80, 14).join("\n");
  expect(rows).toContain("File name");
  expect(rows).toContain("Folder");
  expect(rows).toContain(tail);
  expect(rows).not.toContain("calls");
  expect(rows).not.toContain("clear");
  ui.input("\tcalls");
  expect(d.browser.focused).toBe(true);
  expect(d.browser.folder()).toBe(join(folder, "calls"));
});

test("a folder typed in the dialog that is not there yet is made, for the user alone", () => {
  const { ui, folder, started } = recording();
  ui.input("r");
  ui.input("\tnew/");
  const d = ui.prompt!.dialog;
  expect(d.browser.folder()).toBe(join(folder, "new"));
  expect(screen(ui.draw(80, 20), 80, 20).join("\n")).toContain("Create new");
  ui.input("\r");
  expect(started).toEqual([join(folder, "new", d.name())]);
  expect(statSync(join(folder, "new")).mode & 0o777).toBe(0o700);
});

test("Enter starts the recording; the mode row shows REC and the footer the keys", () => {
  const { ui, recorder, folder, started } = recording();
  let footer = screen(ui.draw(80, 20), 80, 20)[19];
  expect(footer).toContain(" r  record");
  expect(footer).not.toContain(" R ");
  ui.input("r");
  ui.input(clear + "call.txt\r");
  expect(started).toEqual([join(folder, "call.txt")]);
  expect(ui.prompt).toBeNull();
  expect(recorder.current?.path).toBe(join(folder, "call.txt"));
  const frame = ui.draw(80, 20),
    rows = screen(frame, 80, 20);
  expect(rows[3]).toContain("Mode:    Listening  ● REC");
  expect(frame).toContain(new Style({ fg: "hot", bg: "bg", bold: true }).sgr() + "  ● REC");
  footer = rows[19];
  expect(footer).toContain(" r  pause");
  expect(footer).toContain(" R  stop");
  // The keys after it keep their place whatever r says.
  expect(footer.indexOf(" R ")).toBe(screen(ui.draw(80, 20), 80, 20)[19].indexOf(" R "));
  expect(wide(ui)).toContain(`○ ${clock(0)} recording started: ${join(folder, "call.txt")}`);
});

test("the prompt takes a name in UTF-8, as the terminal sends it", () => {
  const { ui, folder, started } = recording();
  ui.input("r");
  // Keys reach the window as latin1 bytes; a character may span two reads.
  const bytes = Buffer.from("café-日本.txt", "utf8").toString("latin1");
  ui.input(clear);
  ui.input(bytes.slice(0, 4));
  ui.input(bytes.slice(4));
  expect(ui.prompt?.dialog.name()).toBe("café-日本.txt");
  expect(hint(ui)).toBe(join(folder, "café-日本.txt"));
  ui.input("\r");
  expect(started).toEqual([join(folder, "café-日本.txt")]);
});

test("the prompt says when the name is an existing file it appends to", () => {
  const { ui, folder } = recording();
  writeFileSync(join(folder, "notes.txt"), "Earlier.\n");
  ui.input("r");
  ui.input(clear + "notes.txt");
  expect(hint(ui)).toBe(`appends to the existing file: ${join(folder, "notes.txt")}`);
  expect(screen(ui.draw(100, 20), 100, 20).join("\n")).toContain("appends to the existing file: ");
  ui.input("\x1b");
  ui.input("r");
  ui.input(clear + "~/x.txt");
  expect(screen(ui.draw(80, 20), 80, 20).join("\n")).toContain("/home/me/x.txt");
});

test("R stops the recording, and quitting from the prompt makes no file", async () => {
  const { ui, calls, recorder, folder, stops } = recording();
  ui.input("r");
  ui.input(clear + "a.txt\r");
  ui.input("R");
  expect(stops()).toBe(1);
  expect(recorder.current).toBeNull();
  expect(screen(ui.draw(80, 20), 80, 20)[3]).not.toContain("REC");
  await Bun.sleep(0);
  expect(wide(ui)).toContain(`stopped: ${join(folder, "a.txt")}`);
  ui.input("r");
  ui.input(clear + "b.txt");
  ui.input("\x03");
  expect(ui.prompt).toBeNull();
  expect(calls.quit).toBe(1);
  expect(existsSync(join(folder, "b.txt"))).toBe(false);
});

test("a file that cannot be opened is reported in the status line and the history", () => {
  const { ui, folder } = recording();
  writeFileSync(join(folder, "taken"), "");
  ui.input("r");
  ui.input(clear + "taken/x.txt\r");
  const rows = screen(ui.draw(120, 20), 120, 20);
  expect(rows[9]).toContain("Cannot write the transcript: ");
  expect(rows.join("\n")).toMatch(/✗ \d\d:\d\d:\d\d recording not started: /);
  expect(rows[3]).not.toContain("REC");
});

test("recorder notices and passages share the history in time order", () => {
  const { ui, session, recorder } = recording();
  recorder.notices.push({ at: 1500, kind: "info", text: "paused" });
  recorder.notices.push({ at: 3500, kind: "error", text: "1 passage did not finish in time" });
  session.history = [
    { ...said(1, "delivered", "first"), captured_at: 1000 },
    { ...said(2, "delivered", "second"), captured_at: 2000 },
  ];
  const lines = screen(ui.draw(80, 20), 80, 20)
    .slice(9, 18)
    .map(r => r.trim())
    .filter(Boolean);
  expect(lines.map(l => l.replace(/\d\d:\d\d:\d\d /, ""))).toEqual([
    "✓ first",
    "○ paused",
    "✓ second",
    "✗ 1 passage did not finish in time",
  ]);
});

test("while quitting waits for the transcript, the status line says so", () => {
  const { ui } = recording();
  ui.finishing = true;
  expect(screen(ui.draw(80, 20), 80, 20)[9]).toContain("Finishing transcript…");
});

test("a passage written but not typed shows as recorded, with why unless it was the mute", () => {
  const { ui, session, recorder } = recording();
  session.history = [said(1, "recorded", "a call", "muted"), said(2, "recorded", "and more", "no viewer attached")];
  const rows = screen(ui.draw(80, 20), 80, 20).join("\n"),
    at = clock(0);
  // Muted is what a recording does by itself: the mark alone says it was written, not typed.
  expect(rows.split("\n").map(r => r.trim())).toContain(`● ${at} a call`);
  expect(rows).not.toContain("(muted)");
  expect(rows).toContain(`● ${at} and more · recorded, not typed (no viewer attached)`);
  // No answer to the typing: written, and perhaps typed, so it does not claim otherwise.
  session.history = [
    { ...said(3, "recorded", "slow", "no answer in time; may have been typed"), maybe_typed: true },
    ...session.history,
  ];
  const slow = screen(ui.draw(100, 20), 100, 20).join("\n");
  expect(slow).toContain(`● ${at} slow · recorded (no answer in time; may have been typed)`);
  expect(slow).not.toContain("slow · recorded, not typed");
  expect(ui.draw(80, 20)).toContain(new Style({ fg: "muted", bg: "bg" }).sgr() + "a call");
  // Muted while recording: the note and the meter stay grey; REC says speech is still kept.
  session.muted = true;
  const dir = mkdtempSync(join(tmpdir(), "corgi-ui-"));
  folders.push(dir);
  recorder.start(join(dir, "t.txt"));
  const frame = ui.draw(80, 20);
  expect(screen(frame, 80, 20)[3]).toContain("Mode:    MUTED  ● REC");
  expect(frame).toContain(new Style({ fg: "muted", bg: "bg" }).sgr() + "♫");
  // Without a viewer, the status says nothing is typed, not that nothing is recorded.
  session.muted = false;
  session.viewer = false;
  expect(screen(ui.draw(80, 20), 80, 20)[9]).toContain("No Corgi window is attached; nothing is typed until one is");
});

test("r pauses and resumes without a prompt; R stops from paused", () => {
  const { ui, recorder, stops } = recording();
  ui.input("r");
  ui.input(clear + "p.txt\r");
  ui.input("r");
  expect(recorder.current?.state).toBe("paused");
  expect(ui.prompt).toBeNull();
  let frame = ui.draw(80, 20),
    rows = screen(frame, 80, 20);
  expect(rows[3]).toContain("Mode:    Listening  ⏸ paused");
  expect(frame).toContain(new Style({ fg: "warm", bg: "bg" }).sgr() + "  ⏸ paused");
  expect(rows[19]).toContain(" r  resume");
  expect(rows.join("\n")).toContain("○ 00:00:00 paused");
  ui.input("r");
  expect(recorder.current?.state).toBe("running");
  rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[19]).toContain(" r  pause");
  expect(rows.join("\n")).toContain("○ 00:00:00 resumed");
  ui.input("r");
  ui.input("R");
  expect(stops()).toBe(1);
  expect(recorder.current).toBeNull();
  frame = ui.draw(80, 20);
  expect(screen(frame, 80, 20)[3]).not.toContain("paused");
});

test("while quitting waits, r starts nothing new", () => {
  const { ui } = recording();
  ui.finishing = true;
  ui.input("r");
  expect(ui.prompt).toBeNull();
});

/** A running recording with `n` one-line contributions, a minute apart. */
function conversation(n: number) {
  const made = recording();
  made.ui.input("r");
  made.ui.input(clear + "c.txt\r");
  const contributions = made.recorder.current!.turns.contributions;
  for (let i = 0; i < n; i++) contributions.push({ started_at: 60_000 * i, texts: [`block ${i}`] });
  return { ...made, contributions };
}

test("v without a recording only says why", () => {
  const { ui } = recording();
  ui.input("v");
  expect(ui.reading).toBeNull();
  expect(screen(ui.draw(80, 20), 80, 20)[9]).toContain("The reading view needs a recording: press r");
  ui.input("+");
  expect(screen(ui.draw(80, 20), 80, 20)[9]).not.toContain("reading view");
});

test("the reading view shows each contribution as a block behind alternating gutters", () => {
  const { ui, calls, session, contributions } = conversation(2);
  contributions[1].texts.push("and more");
  expect(screen(ui.draw(80, 20), 80, 20)[19]).toContain(" v  read");
  ui.input("v");
  const frame = ui.draw(80, 20),
    rows = screen(frame, 80, 20);
  const body = rows.slice(9, 18).map(r => r.trimEnd());
  expect(body.slice(0, 5)).toEqual([` ▌ ${clock(0)}`, " ▌ block 0", "", ` ▌ ${clock(60_000)}`, " ▌ block 1 and more"]);
  expect(frame).toContain(new Style({ fg: "accent", bg: "bg" }).sgr() + "▌");
  expect(frame).toContain(new Style({ fg: "warm", bg: "bg" }).sgr() + "▌");
  // The meter and the threshold stay, and so do their keys; the wheel scrolls here.
  expect(rows[4]).toContain("T:44");
  expect(rows[19]).toContain(" v  back");
  ui.input("+");
  ui.input("\x1b[<64;10;12M");
  expect(calls.thresholds).toEqual([46]);
  ui.input("m");
  expect(session.muted).toBe(true);
  expect(ui.reading).not.toBeNull();
  ui.input("v");
  expect(ui.reading).toBeNull();
  ui.input("v");
  ui.input("\x1b");
  expect(ui.reading).toBeNull();
});

test("the reading view follows new speech until scrolled up, and counts what came", () => {
  const { ui, contributions } = conversation(10);
  ui.input("v");
  const body = () =>
    screen(ui.draw(80, 20), 80, 20)
      .slice(9, 18)
      // Without the scroll bar in the last column.
      .map(r => r.slice(0, 79).trim())
      .filter(Boolean);
  expect(body().at(-1)).toBe("▌ block 9");
  contributions.push({ started_at: 600_000, texts: ["block 10"] });
  expect(body().at(-1)).toBe("▌ block 10");
  // Scrolled up, it stays put and the footer counts the new blocks.
  ui.input("k");
  const held = body();
  contributions.push({ started_at: 660_000, texts: ["block 11"] });
  contributions.push({ started_at: 720_000, texts: ["block 12"] });
  expect(body()).toEqual(held);
  expect(screen(ui.draw(80, 20), 80, 20)[19]).toContain("2 new below · G");
  ui.input("G");
  expect(body().at(-1)).toBe("▌ block 12");
  expect(screen(ui.draw(80, 20), 80, 20)[19]).not.toContain("new below");
  // The history's keys scroll it, and End follows again.
  ui.input("g");
  expect(body()[0]).toBe(`▌ ${clock(0)}`);
  ui.input("\x1b[F");
  expect(body().at(-1)).toBe("▌ block 12");
  for (const key of ["\x1b[5~", "\x15", "\x02", "\x1b[A"]) {
    ui.input(key, 20);
    expect(ui.reading?.top).not.toBeNull();
    ui.input("\x1b[F");
  }
  ui.input("\x1b[5~");
  ui.input("\x1b[6~");
  ui.input("\x06");
  ui.input("\x04");
  ui.input("j");
  ui.input("\x1b[B");
  expect(ui.reading?.top).toBeNull();
});

test("in the reading view the wheel scrolls the conversation, and + and - still move the threshold", () => {
  const { ui, calls } = conversation(10);
  ui.input("v");
  ui.draw(80, 20);
  // Wheel up: three lines back from the bottom (20); the threshold stays.
  ui.input("\x1b[<64;40;12M");
  expect(ui.reading?.top).toBe(17);
  ui.input("\x1b[<64;40;12M");
  expect(ui.reading?.top).toBe(14);
  expect(calls.thresholds).toEqual([]);
  expect(
    screen(ui.draw(80, 20), 80, 20)
      .slice(9, 18)
      .some(r => r.endsWith("┃")),
  ).toBe(true);
  // Wheel down back to the bottom follows again.
  ui.input("\x1b[<65;40;12M\x1b[<65;40;12M");
  expect(ui.reading?.top).toBeNull();
  ui.input("+");
  expect(calls.thresholds).toEqual([46]);
  // Above the line, the wheel still moves the threshold.
  ui.input("\x1b[<64;40;4M");
  expect(calls.thresholds).toEqual([46, 48]);
  expect(ui.reading?.top).toBeNull();
});

test("the reading view's scroll bar can be dragged, and a press on its track jumps there", () => {
  const { ui } = conversation(10);
  ui.input("v");
  // 29 lines in 9 rows from row 9; the thumb is 2 rows, at the bottom: rows 16 and 17.
  const bar = () =>
    screen(ui.draw(80, 20), 80, 20)
      .map((r, y) => (r.endsWith("┃") ? y : -1))
      .filter(y => y >= 0);
  expect(bar()).toEqual([16, 17]);
  // Press on the thumb's lower row, drag it to the top: the view goes to the start.
  ui.input("\x1b[<0;80;18M");
  ui.input("\x1b[<32;80;14M");
  expect(ui.reading?.top).toBe(9);
  ui.input("\x1b[<32;80;1M");
  expect(ui.reading?.top).toBe(0);
  expect(bar()).toEqual([9, 10]);
  ui.input("\x1b[<0;80;1m");
  // Released, moving the pointer drags nothing.
  ui.input("\x1b[<32;80;18M");
  expect(ui.reading?.top).toBe(0);
  // A press on the track below the thumb centres the thumb there; the bottom follows again.
  ui.input("\x1b[<0;80;18M\x1b[<0;80;18m");
  expect(ui.reading?.top).toBeNull();
  // A press in the column beside the bar counts; one in the text does not.
  ui.input("\x1b[<0;79;10M\x1b[<0;79;10m");
  expect(ui.reading?.top).toBe(0);
  ui.input("\x1b[<0;20;16M\x1b[<0;20;16m");
  expect(ui.reading?.top).toBe(0);
});

test("each scroll key moves the reading view by its step", () => {
  const { ui } = conversation(10);
  ui.input("v");
  // 10 blocks of two lines and 9 gaps: 29 lines, 9 shown, so 20 is the bottom.
  ui.draw(80, 20);
  const top = () => ui.reading?.top;
  ui.input("g");
  expect(top()).toBe(0);
  const down: [string, number][] = [
    ["j", 1],
    ["\x1b[B", 2],
    ["\x04", 7],
    ["\x06", 16],
  ];
  for (const [key, to] of down) {
    ui.input(key, 20);
    expect(top()).toBe(to);
  }
  ui.input("\x1b[6~", 20);
  expect(top()).toBeNull();
  const up: [string, number][] = [
    ["k", 19],
    ["\x1b[A", 18],
    ["\x15", 13],
    ["\x02", 4],
    ["\x1b[5~", 0],
  ];
  for (const [key, to] of up) {
    ui.input(key, 20);
    expect(top()).toBe(to);
  }
});

test("the meter and Options show the recording's values while it runs", () => {
  const target = { setThreshold: () => {}, setTiming: () => {}, setCap: () => {} },
    tuning = new Tuning(target, {
      dictation: { threshold: 44, silence: 2.5 },
      recording: { threshold: 60, silence: 1, max_chunk: 10, pause_break: 2 },
      shared: { burst: 0.1, pre_roll: 0.3, min_speech: 0.2 },
    }),
    { ui } = recording({ tuning, setThreshold: pct => tuning.setThreshold(pct) }, tuning);
  let rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[4]).toContain("T:44");
  expect(rows[6]).toMatch(/silence +2\.5 s /);
  ui.input("r");
  ui.input(clear + "call.txt\r");
  rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[4]).toContain("T:60");
  expect(rows[6]).toMatch(/silence +1 s /);
  // + steps from the recording's threshold, and stays with the recording.
  ui.input("+");
  expect(screen(ui.draw(80, 20), 80, 20)[4]).toContain("T:62");
  ui.input("R");
  rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[4]).toContain("T:44");
  expect(rows[6]).toMatch(/silence +2\.5 s /);
});

test("stopping the recording closes the reading view", () => {
  const { ui } = conversation(1);
  ui.input("v");
  ui.input("r");
  // Paused, it stays open.
  ui.draw(80, 20);
  expect(ui.reading).not.toBeNull();
  ui.input("R");
  const rows = screen(ui.draw(80, 20), 80, 20);
  expect(ui.reading).toBeNull();
  expect(rows[19]).not.toContain(" v ");
});

test("the help explains recording and its own timing", () => {
  const { ui } = setup();
  ui.input("?");
  for (let i = 0; i < 60; i++) ui.input("j");
  const rows = screen(ui.draw(100, 40), 100, 40).join("\n");
  expect(rows).toContain("record");
  expect(rows).toContain("R stops");
  expect(rows).toContain("max_chunk");
});

test("without a way to start one, r still pauses and resumes a recording but opens no prompt", () => {
  const { ui, recorder, folder } = recording({ resolveName: undefined, startRecording: undefined });
  expect(screen(ui.draw(80, 20), 80, 20)[19]).not.toContain(" r ");
  ui.input("r");
  expect(ui.prompt).toBeNull();
  recorder.start(join(folder, "t.txt"));
  ui.input("r");
  expect(recorder.current?.state).toBe("paused");
  expect(screen(ui.draw(80, 20), 80, 20)[19]).toContain(" r  resume");
  ui.input("r");
  expect(recorder.current?.state).toBe("running");
});

test("+ right after Enter steps from the recording's threshold, with no frame between", () => {
  const target = { setThreshold: () => {}, setTiming: () => {}, setCap: () => {} },
    tuning = new Tuning(target, {
      dictation: { threshold: 44, silence: 2.5 },
      recording: { threshold: 60, silence: 1, max_chunk: 10, pause_break: 2 },
      shared: { burst: 0.1, pre_roll: 0.3, min_speech: 0.2 },
    }),
    { ui } = recording({ tuning, setThreshold: pct => tuning.setThreshold(pct) }, tuning);
  ui.draw(80, 20);
  ui.input("r");
  ui.input(clear + "call.txt\r+");
  expect(tuning.threshold).toBe(62);
  ui.input("R+");
  expect(tuning.threshold).toBe(46);
});
