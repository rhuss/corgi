# Voice dictation

`corgi voice` turns speech into typing. It listens on the machine with the
microphone, transcribes with a local Whisper model, and types what you said
into the focused pane of the viewer you used last. It never presses Enter for
you, and what you say is typed as text, without filler words.

Audio stays on your machine. Only the transcribed text and the mute state
reach the runtime, locally or over SSH.

## Set up

Voice mode needs `whisper-server` and `ffmpeg`, a speech model and a speech filter.

| Platform | Install |
| --- | --- |
| macOS | `brew install whisper-cpp ffmpeg` |
| Arch | `sudo pacman -S whisper-cpp ffmpeg` |
| Debian, Ubuntu | `sudo apt install whisper.cpp-tools ffmpeg` |
| Other Linux | ffmpeg from your package manager; build whisper.cpp with CMake for `build/bin/whisper-server` |

Then run:

```sh
corgi voice setup
```

Setup checks `whisper-server` and `ffmpeg`, then downloads the `base.en`
model and the Silero speech filter into `~/.cache/corgi/voice/`. Each file is
checked against a pinned size and SHA-256 before it is kept. A second run
downloads nothing. Exit status is 0 when voice is ready and 1 otherwise.

`corgi voice setup --model NAME` fetches another model:

| Model | Size | Notes |
| --- | --- | --- |
| `tiny.en` | 78 MB | Fastest, least accurate |
| `base.en` | 148 MB | Default |
| `small.en` | 488 MB | More accurate, slower |
| `medium` | 1.5 GB | Multilingual: detects the language you speak |
| `large-v3-turbo` | 1.6 GB | Multilingual, most accurate |

The speech filter needs a `whisper-server` whose `--help` lists `--vad`.
Setup reports an older one as too old: update whisper.cpp, or run voice mode
with `--no-filter`.

## Dictate

Start Corgi, then run `corgi voice` in another terminal, or in a Corgi pane.
The screen is a small table:

| Field | Shows |
| --- | --- |
| `Target` | `local` or the SSH host, and the title of the pane your text goes to, as `local → dictation` |
| `Device` | The microphone; `(default)` for the system default |
| `Level` | A braille meter in the theme's colors, dimmed while your voice is under the threshold (the bar, `T:`), and grey while muted. A thin grey line grows under it while you pause; when it reaches the end, the utterance ends |
| `Model` | The Whisper model |
| `Mode` | `Listening`, or `MUTED` in red (also while voice cannot listen, as in the sidebar) |
| `Options` | What ends an utterance (`silence`, `burst`), the speech `filter`, and what starts one (`pre-roll`, `min speech`) |

Click an option to change it: a menu opens with a few values to pick with a
click, or with `↑`/`↓` and Enter (Esc closes it). A click on `filter` switches
it.

The `♫` before the title adds what speech is doing: a slightly different
green while listening, recording or transcribing, and grey while voice mode
is muted, not connected to the runtime, or without a viewer. Click it, or the
mode, to mute or unmute. Without a viewer there is nowhere to type, so voice
mode holds off until one attaches, and says so at the top of the history:
`No Corgi window is attached; nothing is typed until one is`. A running
[transcript recording](#record-a-transcript) keeps listening anyway.

The history lists each utterance with the time you said it and, once typed,
how long the text took after you stopped speaking, as in
`✓ 14:02:31 (156ms) text`. A `✗` row says why text was not typed; one that
got no answer in time may still have been typed. What you say while muted, or
what muting cuts off, leaves no row, unless a recording writes it.

An utterance ends after 2.5 seconds of silence and is capped at 30 seconds.
While a recording exists, its own silence and `max_chunk` (10 seconds) apply
instead.
Short peaks under 0.1 seconds, such as music below your voice, don't keep it
open. An utterance that follows another in the same pane is joined to it with
one space; after anything else you type, it starts fresh.
Filler words (um, uh, hmm, ah, er) are removed from the text. Sounds Whisper
describes, such as `*clap*` or `[BLANK_AUDIO]`, are removed too, alone or
beside speech, and lines it invents from silence ("Thank you.") are not typed
at all.

If voice mode runs in a Corgi pane and that pane has focus, nothing is typed:
the history says "focused pane is the voice pane".

| Key | Does |
| --- | --- |
| `m` | Mute or unmute |
| `?` | Explain the options and how each changes what becomes text |
| `+` / `-` | Raise or lower the threshold by 2 (or turn the mouse wheel anywhere in the window) |
| `f` | Turn the speech filter on or off; restarts whisper-server, about a second, and brings it back after a crash |
| `d` | Pick another microphone |
| `r` | Start a recording, or pause and resume it |
| `R` | Stop the recording |
| `v` | Open or close the reading view, while there is a recording |
| `j` / `k`, `↓` / `↑` | Scroll the history by a row |
| `Ctrl+D` / `Ctrl+U` | Scroll by half a page |
| `Ctrl+F` / `Ctrl+B`, `PgDn` / `PgUp` | Scroll by a page |
| `g` / `G` | Oldest / newest |
| `q`, `Ctrl+C` | Quit; stops ffmpeg and whisper-server |

Threshold, option and filter changes last for the session. Put values you
like in `voice.json`. The line under the level grows while you pause, so you can
see when the utterance is about to end. `Target:` follows the focused pane as you move around in Corgi. The footer lists as many keys as fit.

## Mute

Voice mode and Corgi share one mute state. Press `m` in voice mode, or
**prefix M** in Corgi (every preset). **prefix m** still mutes sounds. The
sidebar's title row shows a green `♫` while voice listens and a faint one
while it is muted; click it to toggle. Beside the corgi badge the title
shortens to make room; with no voice attached it is gone.
`corgi action voice-mute` does the same from a script.

Muting drops anything not yet typed, though a running recording still writes
it. When the microphone or Whisper fails, the indicator shows muted and
unmuting has no effect until it recovers.

## Record a transcript

Voice mode can also write what you say to a text file, for a meeting or your
own notes. Dictation keeps working while it records.

| Key | Does |
| --- | --- |
| `r` | No recording: open the filename prompt. Recording: pause. Paused: resume |
| `R` | Stop, whether running or paused |
| `v` | Open the [reading view](#reading-view) |

The prompt suggests `transcript-YYYY-MM-DDTHH-MM-SS.txt`, in local time. The
first character you type replaces it. Backspace deletes, Ctrl+U clears, Enter
starts the recording and Esc cancels; Ctrl+C cancels and quits. The line under
the field shows the file the name resolves to,
`appends to the existing file: PATH`, or why the name is refused:
`name is empty` or `stays inside the transcript folder: remove ..`.

A relative name goes into the transcript folder and may contain sub-folders,
which are created as needed. `~/` means your home folder, and an absolute
path is used as given. No extension is added, and `..` may not climb out of
the folder.

While recording, the mode row shows a red `● REC`; while paused, `⏸ paused`.
The footer gains `r record|pause|resume`, `R stop` and `v read|back`, and
drops keys from the right when the window is narrow. The history marks each
step:

| Row | Means |
| --- | --- |
| `○ recording started: PATH` | The file is open |
| `○ paused`, `○ resumed` | Passages in between are not written |
| `○ stopped: PATH` | The file is closed |
| `● TEXT · recorded, not typed (REASON)` | Written but not typed, because voice mode is muted, has no viewer attached, is not connected, has a backlog, or the delivery failed |
| `● TEXT · recorded (no answer in time; may have been typed)` | Written, and sent to be typed, but the runtime did not answer in time, so it may have been typed |
| `✗ recording not started: REASON` | The file could not be created or opened |
| `✗ recording stopped: REASON` | A write failed. The recording closes, the text written so far stays, and dictation goes on |
| `✗ recording "pause_break" (P s) is not longer than "silence" (S s), ...` | A silence chosen under `Options` during a recording leaves every passage its own contribution |
| `✗ N passages did not finish in time` | They were still being transcribed when the recording closed, and are not in the file |

After a failed start or write, the status line also says
`Cannot write the transcript: REASON`.

### The file

Transcripts go to `~/.local/share/corgi/transcripts/` (or
`$XDG_DATA_HOME/corgi/transcripts/`) on the machine running voice mode, unless
[`transcripts` or `--transcripts`](#settings) names another folder. Each line
is one passage. A blank line comes before each passage that starts a new
contribution, but never at the top of a new file. There are no timestamps or
speaker labels:

```text
Okay, so let's go over the plan for today.
First the release notes.

Sounds good. I have a question about the schedule.

Sure, go ahead.
```

Files are UTF-8 with `\n` line ends. A new transcript is readable and writable
only by you (0600); folders voice mode creates are 0700. Each passage is
synced to disk as it is written. Choosing an existing file appends to it after
exactly one blank line: a missing final line break is added first, and a
trailing blank line is reused. Nothing is overwritten, and the existing file
keeps its permissions.

### Contributions

Voice mode doesn't tell speakers apart by their voice. A passage starts a new
contribution when:

- the silence before it is longer than `recording.pause_break` (2 seconds),
  measured from the last loud audio of the previous passage to the first of
  this one, without pre-roll;
- its text starts with a hyphen, en dash or em dash and a space; the dash is
  left out of the file and the reading view, but dictation types it;
- it is the first passage after starting, or the first one you started saying
  after you paused, once you resume. A passage you said before the pause that
  is written only after the resume stays with what came before it.

A passage cut at `max_chunk` continues the same contribution. Passages the
filter removes (filler words, sound markers, lines Whisper invents from
silence) are not written.

### Mute, pause and quit

While a recording runs, voice mode keeps listening when muted, with no Corgi
window attached, or with no runtime to reach. It writes the passages and
doesn't type them; the same goes for a passage you were saying when you muted
or the viewer left, and for one you started while muted or with no viewer
attached, even if that changes before it ends. Without a recording, or with the recording paused, muting
drops the audio.

While paused, passages still show in the history and are typed as usual, but
are not written.

Quitting with a recording (`q` or Ctrl+C) keeps the window open with
`Finishing transcript…` while passages still being transcribed finish, for
up to 10 seconds. Press `q` or Ctrl+C again to stop waiting. If any were left
out, voice mode prints this after the window closes:
`corgi: N passages of PATH did not finish in time and are not in the transcript`.

Stopping with `R` removes the REC mark at once, then waits up to 10 seconds in
the background before it closes the file.

### Timing while recording

While a recording exists, running or paused, its threshold, silence and
`max_chunk` apply to everything voice mode hears, dictation included. Typed
text then arrives in shorter pieces. Stopping restores the dictation values.

Changing the threshold (`+`/`-`, the wheel) or the silence (Options) during a
recording changes the recording's values, and later recordings in the same
run keep them. Burst, pre-roll and min speech are shared and stay as they are.
The Options row shows the values in effect. With `recording.threshold` unset,
each recording starts from the dictation threshold in effect, until you
change it during a recording.

## Reading view

`v` opens the reading view while a recording runs or is paused; without one,
the status line says `The reading view needs a recording: press r`. `v` or
Esc closes it, and it closes by itself when the recording stops.

It replaces the history with the current recording, one block per
contribution: the local time its first loud audio began (`HH:MM:SS`, without
pre-roll), then its text, wrapped to the window. A `▌` bar in front of each
block alternates between the theme's accent green and its warm color. The view
shows only what was written: muted passages are there, paused ones are not.

The view follows new speech at the bottom. Scroll up and it stops following;
the footer then shows `N new below · G`, and `G` or End jumps back and follows
again.

| Key | Does |
| --- | --- |
| `j` / `k`, `↓` / `↑` | Scroll by a line |
| `Ctrl+D` / `Ctrl+U` | Scroll by half a page |
| `Ctrl+F` / `Ctrl+B`, `PgDn` / `PgUp` | Scroll by a page |
| `g`, Home / `G`, End | Oldest / newest |

The level meter and `T:` stay, and `m`, `+`/`-`, the wheel, `r`, `R` and `q`
keep working.

## Remote runtimes

```sh
corgi voice --ssh devbox
```

Voice mode runs here, with your microphone and model, and starts
`corgi __voice-bridge` on the host through `ssh -T`. Host key and password
prompts come before the screen takes over; reconnects use `BatchMode`, so set up
key authentication for unattended use. The host needs a Corgi with voice
support and a running runtime. Your local `voice.json` applies; a `voice.json`
on the host is ignored. Transcripts are written here too, on the machine with
the microphone; nothing is stored on the host.

If the link drops, what you say meanwhile fails as "not connected" and is
never typed later. Voice mode reconnects every 5 seconds and restores its mute
state.

## Settings

`~/.local/state/corgi/voice.json` (or under `$XDG_STATE_HOME`) on the machine
running voice mode. Every field is optional.

```json
{
  "threshold": 44,
  "silence": 2.5,
  "pre_roll": 0.3,
  "min_speech": 0.2,
  "burst": 0.1,
  "model": "base.en",
  "speech_filter": true,
  "device": null,
  "transcripts": "~/notes/transcripts",
  "recording": {
    "threshold": 40,
    "silence": 1.0,
    "max_chunk": 10,
    "pause_break": 2.0
  }
}
```

| Field | Default | Flag |
| --- | --- | --- |
| `threshold` | 44, on a 0 to 100 scale | `--threshold N` |
| `silence` | 2.5 seconds, 0.5 to 10 | `--silence SECONDS` |
| `pre_roll` | 0.3 seconds, 0 to 2: audio kept from before you start | |
| `min_speech` | 0.2 seconds, 0.02 to 2: shorter sounds are dropped | |
| `burst` | 0.1 seconds, 0.02 to 1: shorter peaks don't keep an utterance open | |
| `model` | `base.en` | `--model NAME` |
| `port` | a free port each run, for whisper-server on 127.0.0.1 | `--port PORT` |
| `speech_filter` | `true` | `--no-filter` |
| `device` | system default | `--device ID` |
| `transcripts` | `$XDG_DATA_HOME/corgi/transcripts`, or `~/.local/share/corgi/transcripts` without `XDG_DATA_HOME`; an absolute folder or one starting with `~/` | `--transcripts DIR` |
| `recording.threshold` | follows the dictation threshold; a whole number, 0 to 100 | |
| `recording.silence` | 1.0 seconds, 0.5 to 10: ends a passage while recording | |
| `recording.max_chunk` | 10 seconds, 5 to 30: longest passage while recording | |
| `recording.pause_break` | 2.0 seconds, 0.5 to 30: a longer silence starts a new contribution | |

A bad field falls back to its default, and voice mode shows a notice naming
it, such as `voice.json: "recording.silence" must be 0.5..10; using 1`. A
`recording` that is not an object uses all its defaults. When `pause_break` is
not longer than `silence`, a notice says every passage starts a new
contribution, and both values are kept. The history says so too when a
silence chosen under `Options` during a recording reaches `pause_break`. Changes to `voice.json` apply the next
time voice mode starts.

Flags apply to one run. `--transcripts DIR` is relative to the folder you
started `corgi voice` in. The transcript folder comes from the flag, then
`transcripts`, then `$XDG_DATA_HOME/corgi/transcripts`, then
`~/.local/share/corgi/transcripts`. whisper-server answers anything on its port
without authentication, so leave `port` unset unless you need a fixed one.

`--verbose` appends one line per utterance (duration, transcription and
delivery times, outcome) and whisper-server's health to `voice.log` beside
`voice.json`. It also logs when a recording starts, pauses, resumes and stops,
with the file path, how long a stop waited (`waited_ms`, `late`), and write
errors, but never the transcribed text. Nothing goes to the screen.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Microphone access denied" | macOS: allow your terminal app in System Settings › Privacy & Security › Microphone, then restart the terminal |
| "The microphone is in use by another program" | Close the other program; voice mode retries every 5 seconds |
| "No microphone found" | Press `d` and pick one, or check `--device` |
| "port N is in use" | Set another `port` in `voice.json`, pass `--port`, or leave it unset |
| "The speech filter is not installed" | Run `corgi voice setup`; without it, noise can turn into text |
| "this Corgi daemon has no voice support" | `corgi reload` to replace the daemon |
| "Corgi on HOST has no voice support" | Install a Corgi with voice support on the host |
| "The Whisper server stopped" | Press `f` for a fresh one (it switches the filter), or quit and start voice mode again |
| Background noise becomes text | Raise the threshold with `+`, or keep the speech filter on |
| Quiet speech is missed | Lower the threshold with `-` until the meter crosses the marker as you speak |
| "Cannot write the transcript" | The status line and history name the system's error. Check the folder's permissions, free space, and the path; a name that is an existing folder fails too. Dictation keeps working |
| Every passage is its own block | `recording.pause_break` is not longer than `recording.silence`, or shorter than the speakers' pauses. Raise `pause_break` above `silence` |
