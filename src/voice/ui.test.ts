import { test, expect, afterEach } from "bun:test";
import { VoiceUi, problem, type Options } from "./ui";
import { clock } from "./reading";
import { VoiceSession, type Utterance } from "./session";
import { Segmenter, default_timing } from "./segmenter";
import type { Device } from "./capture";
import * as palette from "../palette";
import { Style } from "../palette";
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
      transcriber: { transcribe: async () => "", on: () => {} },
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
  expect(rows[6]).toMatch(/^ Options: silence +2\.5 s +burst +0\.1 s +filter on/);
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

test("the wheel moves the threshold anywhere in the window", () => {
  const { ui, calls } = setup();
  ui.input("\x1b[<64;10;3M");
  ui.input("\x1b[<65;10;3M\x1b[<65;10;3M");
  ui.input("\x1b[<64;40;12M");
  expect(calls.thresholds).toEqual([46, 44, 42, 44]);
});

test("PgUp and PgDn page through the history", () => {
  const { session, ui } = setup();
  session.history = Array.from({ length: 40 }, (_, i) => said(i + 1, "delivered", `line ${i + 1}`));
  let rows = screen(ui.draw(80, 20), 80, 20);
  expect(rows[17]).toContain("line 40");
  expect(rows.some(r => r.includes("┃") && r.endsWith("┃"))).toBe(true);
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

test("? explains the options in an overlay that scrolls when it does not fit", () => {
  const { ui, calls } = setup();
  ui.input("?");
  let rows = screen(ui.draw(80, 40), 80, 40).join("\n");
  expect(rows).toContain("╭─ Options");
  for (const name of ["threshold", "silence", "burst", "filter", "pre-roll", "min speech"])
    expect(rows).toContain(name);
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
  expect(screen(ui.draw(80, 20), 80, 20)[6]).toContain("filter switching…");
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
  expect(rows[6]).toContain("filter not installed");
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

test("a passage written but not typed shows as recorded, with why", () => {
  const { ui, session, recorder } = recording();
  session.history = [said(1, "recorded", "a call", "muted"), said(2, "recorded", "and more", "no viewer attached")];
  const rows = screen(ui.draw(80, 20), 80, 20).join("\n"),
    at = clock(0);
  expect(rows).toContain(`● ${at} a call · recorded, not typed (muted)`);
  expect(rows).toContain(`● ${at} and more · recorded, not typed (no viewer attached)`);
  // No answer to the typing: written, and perhaps typed, so it does not claim otherwise.
  session.history = [
    { ...said(3, "recorded", "slow", "no answer in time; may have been typed"), maybe_typed: true },
    ...session.history,
  ];
  const slow = screen(ui.draw(100, 20), 100, 20).join("\n");
  expect(slow).toContain(`● ${at} slow · recorded (no answer in time; may have been typed)`);
  expect(slow).not.toContain("slow · recorded, not typed");
  expect(ui.draw(80, 20)).toContain(new Style({ fg: "muted", bg: "bg" }).sgr() + "a call · recorded");
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
  // The meter and the threshold stay, and so do their keys.
  expect(rows[4]).toContain("T:44");
  expect(rows[19]).toContain(" v  back");
  ui.input("+");
  ui.input("\x1b[<64;10;12M");
  expect(calls.thresholds).toEqual([46, 48]);
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
