# Changelog

## 0.4.0 — stage 4: design pass

- Rebuilt the look in the Teenage Engineering spirit: monochrome, lowercase, ruled sections numbered
  like the manual, one orange for the live thing, generous spacing, mono for every number.
- Sliders replaced by round dials: drag up / down (⇧ for fine), scroll, double-click to reset,
  arrow keys when focused. Loop start / end stay as thin sliders.
- Checkboxes replaced by round switches; processing laid out as a row of switches and a row of dials.
- Round zone-map slots, ruled zone list, quieter buttons, pill mode switch, round theme toggle.
- Light and dark themes tuned; the theme is applied before first paint to avoid a flash.
- Abort is immediate during a run; end note follows the step for 24 zones; latching play button;
  releasing a key leaves the loop and plays the tail; the keyboard selects the zone it plays.

## 0.3.0 — stage 3: review and loop editing

- Loop editor on the selected zone: scroll to zoom, drag to pan, zoom-to-loop; draggable loop
  handles that snap to rising zero crossings (hold ⌥ to move freely); a splice view showing the
  audio either side of the loop join.
- The loop search window is drawn on every zone and can be dragged on the big waveform; it applies
  to all zones. "Apply to all" places every zone's loop at the same relative position, snapped.
- Detect pitch for one zone or all; shows note, cents and Hz; "use as root" sets the key centre.
  Optional "retune zones to detected pitch" fine-tunes the audio by resampling.
- Per-zone fade-out override.
- Export raw takes as a separate zip (untrimmed, at the recorded rate).
- The session is kept in the browser (IndexedDB) and offered for restore after a reload.
- Keyboard shows which zone each key plays and marks root notes.
- Double-click the waveform to audition from that point.
- Default "untitled" exports get a time suffix so repeated downloads don't collide in Finder.
- Pitch detector rewritten to take the first strong autocorrelation peak (fixes sub-harmonic locks).

## 0.2.0 — stage 2: auto-sample

- Auto-sample mode: choose a MIDI output and channel, an audio input and channel pick (1, 2 or the
  1+2 pair), with a live input meter.
- Test note measures round-trip latency, release tail, noise floor and peak; latency and release
  can be overridden by hand.
- Range planner: start / end note, step in semitones, optional snap to the C grid, hold time and
  velocity; live zone count and estimated time; refuses more than 24 zones and offers the nearest
  step or end note that fits; warns when hold + release exceeds 20 s.
- Run records one continuous stream through an AudioWorklet and slices each note out, with
  per-note progress and abort (sends all-notes-off).
- Auto-sampled zones use the measured latency as the onset guard and the held portion of the note
  as the loop search window; a zone can be re-recorded from the detail panel.
- Preset name and note convention moved to a shared strip; processing / zones / export panels are
  now shared by both modes.

## 0.1.0 — stage 1: import and export

- Import a folder (or drag-and-drop a directory) of WAV / AIFF / FLAC samples, one note per file.
  Note is read from the filename (`c3`, `C#3`, `Db3`, `60`, with space / hyphen / underscore
  separators), then the WAV `smpl` chunk or AIFF `INST` chunk, then by pitch detection, then by asking.
- Long-recording mode: chop one file of ascending notes by silence and assign notes from a start
  note and a semitone step.
- Processing pipeline: trim leading / trailing silence, loop-point search on zero crossings favouring
  the longest clean region, peak normalise, 20 s cap, optional cut at loop end and fade out.
- 24-slot zone map, per-zone waveform, loop nudge, computer-keyboard audition with pitch shifting.
- Export a `name.preset.zip` with `patch.json` (schema cloned from a device-written preset) and
  16-bit WAVs at 44.1 / 22.05 / 11.025 kHz, mono or stereo, root note and loop in the `smpl` chunk.
- Thinning to 24 evenly spaced zones when more are loaded.
- Light / dark theme.
