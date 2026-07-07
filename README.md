# RadioPlayer — Phase 1

Bespoke, embeddable, CMS-agnostic online radio player widget. Single JS file, no build step, no framework dependency.

Live demo: https://victorykhan.github.io/radio-player/

## Embed

```html
<script src="https://victorykhan.github.io/radio-player/radio-player.js"></script>
<div id="radio-player"></div>
<script>
  RadioPlayer.init({
    stationId: "vawam-radio",
    streamUrl: "https://play.vawam.ca/stream.mp3",
    hlsUrl: "https://play.vawam.ca/hls/master.m3u8",
    apiBase: "https://play.vawam.ca",
    theme: "dark",
    defaultVisualizer: "spectrum"
  });
</script>
```

Works in static HTML today. Same call also works inside a WordPress post/page (Custom HTML block), a Laravel Blade view, or a Flask/Jinja template — proper CMS packaging (shortcode, Blade component, Flask-Admin model) is a later phase.

## Config options

| Key | Default | Notes |
|---|---|---|
| `container` | `"radio-player"` | id of the target `<div>`, or a DOM node |
| `stationId` | `""` | your station identifier |
| `streamUrl` | — | direct MP3/Icecast stream URL |
| `hlsUrl` | — | HLS master playlist URL (optional) |
| `apiBase` | — | base URL for `/api/public/now-playing`, `/history`, `/schedule`, `/api/settings/public` |
| `theme` | `"dark"` | `"dark"` or `"light"` |
| `defaultVisualizer` | `"spectrum"` | `spectrum` \| `waveform` \| `circular` \| `particles` \| `glow` |
| `primaryColor` / `secondaryColor` | from `/api/settings/public` | override the station's brand colors |
| `logoUrl` / `stationName` | from `/api/settings/public` | override station branding |

## What's in Phase 1

- Playback: MP3 always works; HLS auto-attempts via `hls.js` (Chrome/Firefox/Edge) or natively (Safari). Auto-reconnect with exponential backoff on stream errors/stalls.
- Web Audio enhancements: 6 EQ presets (flat/pop/rock/jazz/classical/vocal) + custom bass/treble/stereo-width/compressor controls — these work regardless of the stream's CORS status.
- 5 visualizers (spectrum, waveform, circular pulse, particle field, ambient glow) driven by real FFT data when available.
- Live now-playing, up-next, recently played, and schedule — all wired to the station's real public API.
- Stream quality control: when `hls.js` is active, a dropdown lists the master playlist's renditions (Auto/High/Medium/Low, labeled with actual kbps) and lets you pin one manually; a small status label always shows the active format (`HLS · Auto (211 kbps)`, `HLS · native (Auto)`, or `MP3 · direct stream`). Hidden automatically when there's nothing to switch (plain MP3, or Safari's native HLS engine, which manages renditions internally with no JS-facing API).
- LocalStorage persistence for visualizer choice, volume, and EQ preset.
- Share buttons (WhatsApp, Facebook, Twitter/X, SMS, Instagram-via-clipboard, native Web Share where supported).

## Known limitation: stream CORS

`play.vawam.ca`'s audio stream endpoints (`stream.mp3`, `hls/master.m3u8`) don't currently send `Access-Control-Allow-Origin`. This widget detects that automatically on every load and degrades gracefully:

- **Playback**: unaffected — always works via plain `<audio>`.
- **Visualizers**: without CORS, the FFT data path is unavailable (the browser silently zeroes it out), so the widget falls back to a simulated-but-lively animation and shows a small "simulated" note in the corner.
- **HLS in Chrome/Firefox/Edge**: needs CORS to let `hls.js` fetch segments; without it, those browsers automatically use the MP3 stream instead. Safari's native HLS engine works regardless.

To unlock real FFT visualizers and full HLS support everywhere, add `https://victorykhan.github.io` to the stream server's CORS allowlist (or send `Access-Control-Allow-Origin: *` from nginx). No widget code changes are needed — it re-checks on every page load and upgrades automatically.

## Not in Phase 1

Ad-server integration (VAST/VMAP, ad zones, companion banners), admin configuration panel, analytics dashboard, and WordPress/Laravel/Flask packaging — these depend on real backend infrastructure and are later phases.
