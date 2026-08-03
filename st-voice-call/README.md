# Voice Call & Screen Share for SillyTavern

Turns a chat into a phone/video-call-style session:

- **Voice call loop** — continuous browser speech recognition transcribes what
  you say, auto-sends it after a short pause, waits for the reply, and mutes
  itself while your existing TTS provider is speaking so the bot doesn't hear
  itself. When TTS finishes, the mic reopens automatically.
- **Screen share** — captures your screen and attaches a frame to each
  message you send while sharing is active, for vision-capable models.

It does **not** replace or reconfigure your TTS setup — it just listens for
the standard `TTS_JOB_STARTED` / `TTS_JOB_COMPLETE` events your existing TTS
extension already fires, and uses that as the "bot is talking" / "bot is done
talking" signal for turn-taking. Whatever provider/voice you already have
configured in the built-in TTS extension keeps working unchanged.

Speech recognition is done with the browser's own Web Speech API
(`SpeechRecognition` / `webkitSpeechRecognition`) rather than hooking into
ST's built-in Speech Recognition extension, because that gives this extension
direct control over start/stop timing, which the call loop needs. This means
it needs no extra setup — but it also means it currently only works in
Chromium-based browsers (Chrome, Edge, Brave, Opera), since Firefox and
Safari don't implement that API.

## Install

1. In SillyTavern: **Extensions → Install Extension**, paste the URL of the
   repo you push these files to (or use "Install for all users" and drop this
   folder directly into `data/<user-handle>/extensions/st-voice-call` for
   local development — no build step needed).
2. Make sure the folder name matches `st-voice-call` (or update
   `TEMPLATE_PATH` in `index.js` to match whatever you name it — this is only
   used to locate `settings.html`).
3. Reload SillyTavern. Open **Extensions settings → Voice Call & Screen
   Share** to configure.

## Using it

- Click **Start Call** in the settings panel (or the floating bar that
  appears). The mic button turns green while listening, blue while the bot is
  speaking, and grey/off otherwise.
- Talk normally — after ~1.2s of silence (configurable) it sends what you
  said and waits for the reply.
- Click the screen icon to start/stop screen sharing. While active, every
  message you send includes the current frame.
- **Push-to-talk mode** (checkbox in settings) swaps the auto-silence
  detection for hold-to-speak on the mic button, if you'd rather not rely on
  silence timing.

## Requirements & caveats

- **Screen share needs a vision-capable model** with "Send inline images"
  enabled in your Chat Completion connection settings, or the model won't
  actually see the frame even though it's attached.
- The screen-share frame is attached via a `generate_interceptor`
  (`STVoiceCallInterceptor` in `manifest.json`) using the
  `extra.image` / `extra.inline_image` message fields. This matches ST's
  multimodal image pipeline as of mid-2026; if a future ST update changes
  that shape and frames stop being picked up, check the source of the
  official [Extension-ScreenShare](https://github.com/SillyTavern/Extension-ScreenShare)
  for the current field names — you can also just run that extension
  alongside this one and only use this one for the voice-call loop.
- Turn-taking ("mic reopens after the bot stops talking") relies on your TTS
  provider emitting `TTS_JOB_COMPLETE`. If you have TTS auto-narration turned
  off, or a provider that doesn't emit it reliably, the extension falls back
  to reopening the mic shortly after text generation finishes instead
  (`resumeDelayMs`) — tune that value, or use push-to-talk if timing feels
  off.
- Everything here runs client-side in the browser; no server plugin
  required.

## Files

- `manifest.json` — entry point + the `generate_interceptor` registration.
- `index.js` — call state machine, speech recognition, screen capture, UI.
- `settings.html` — settings panel template.
- `style.css` — floating call-bar styling.
