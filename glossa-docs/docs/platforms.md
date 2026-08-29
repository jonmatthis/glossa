---
sidebar_position: 6
title: Platforms & Build
---

# Platforms & Build

Current reality: **Windows desktop dev + NSIS installer works.** Everything
else is a plan with concrete first steps. The good news: the foundation is
already mobile-shaped — `Cargo.toml` builds `staticlib` + `cdylib` + `rlib`
(`src-tauri/Cargo.toml:9`), all heavy work lives in the Rust core, and the
frontend is plain React that runs in any webview.

## Target matrix

| Platform | Status | Artifact | Notes |
|---|---|---|---|
| Windows 10/11 x64 | **Works** (dev + build) | NSIS installer + portable exe | Primary dev machine |
| macOS (aarch64/x64) | Config exists, untested | `.app` / `.dmg` | `bundle.targets: "all"`; needs signing/notarization story |
| Linux x64 | Config exists, untested | deb / AppImage / rpm | webkit2gtk dep |
| Android | Not scaffolded | `.apk` / `.aab` | `tauri android init` pending; see below |
| iOS | Not scaffolded | `.ipa` | Mac + Apple dev account required; see below |
| Browser (no Rust) | Intentionally non-functional | — | `App.tsx` shows a "run via tauri dev" notice |

## Desktop (today)

```powershell
# dev
npm install
npm run tauri dev      # vite :1420 strict port + cargo debug build

# installer
npm run tauri build    # → src-tauri/target/release/bundle/...
```

- `tauri.conf.json`: window 1200×800 (min 900×620), `beforeBuildCommand` runs
  `tsc && vite build`, `frontendDist: ../dist`.
- Release: `strip = true`, `lto = true`.
- Icons: png 32/128/256 + `.ico` only. **Missing `.icns`** — macOS bundling
  will want it (`tauri icon` regenerates the full set from one source).
- Capabilities: desktop `core:default` + `log:default`
  (`capabilities/default.json` — schema path is `gen/schemas/desktop-schema.json`).

### Packaging hygiene to add soon
1. Version stamping (app version currently duplicated in `package.json`,
   `tauri.conf.json`, `Cargo.toml`).
2. Per-platform CI (GitHub Actions matrix: `windows-latest`, `macos-latest`,
   `ubuntu-22.04` with `webkit2gtk-4.1-dev`).
3. macOS codesigning + notarization decision (unsigned builds trigger
   Gatekeeper warnings).

## Mobile — the concrete path (Tauri v2)

### Android

1. **Scaffold:** `npm run tauri android init` → creates
   `src-tauri/gen/android` (Gradle project). Today `gen/` holds only schemas.
2. **Toolchain:** Android Studio (SDK + NDK), Rust targets
   `aarch64-linux-android`, `armv7-linux-androideabi`, `x86_64-linux-android`,
   plus `cargo-tauri`'s ndk wiring.
3. **Permissions:** add `RECORD_AUDIO` to the generated
   `AndroidManifest.xml`; add a mobile capability file (e.g.
   `capabilities/mobile.json` with the same permissions; schema moves to the
   mobile schema).
4. **STT format:** the Android WebView (Chromium) `MediaRecorder` produces
   `audio/webm` — matches the hardcoded upload type. Likely works unchanged;
   verify with a real device.
5. **Layout:** the fixed split-pane (`GuidedPage`) needs a narrow-viewport
   mode (stacked chat/breakdown, breakpoint via CSS or a toggle).
6. **Build/run:** `npm run tauri android dev` (device/emulator), then
   `npm run tauri android build` for APK/AAB.

### iOS

1. **Prereqs:** a Mac with Xcode, Apple Developer account (for device +
   TestFlight; simulator is free). Rust target `aarch64-apple-ios`.
2. **Scaffold:** `npm run tauri ios init` → `src-tauri/gen/ios` (Xcode
   project).
3. **Permissions:** `NSMicrophoneUsageDescription` in the generated
   `Info.plist`.
4. **STT format risk (the big one):** WKWebView `MediaRecorder` support lags;
   iOS typically yields `audio/mp4` (AAC). `transcribe_audio` hardcodes
   filename `audio.webm` + mime `audio/webm` (`commands.rs:670-673`). Fix:
   pass the blob's MIME type up from `GuidedPage.toggleMic` and set
   filename/mime accordingly (Groq accepts m4a/mp3/mp4/webm/wav/ogg).
5. **Layout:** same narrow-viewport work; also safe-area insets.
6. **Keys on mobile:** settings.json lands in the app sandbox config dir —
   works, but review R12 (keychain) with mobile in mind.

### Shared mobile concerns
- **Streaming:** SSE via reqwest works on both, but verify streaming
  `Channel<GuidedEvent>` latency in mobile webviews.
- **App size:** reqwest+tokio+tauri is fine; Whisper stays server-side, so no
  native ML weight.
- **Networking & CSP:** revisit `csp: null` (R13) before shipping any mobile
  build; store keys via secure storage (R12).

## Distribution posture (proposal)

1. **Now:** GitHub Releases with per-OS artifacts from CI; no auto-update.
2. **Next:** Tauri updater plugin (signed updates) once we have stable
   versioning.
3. **Mobile:** TestFlight (iOS) + direct APK then Play Store (Android) when
   the scaffold lands; each needs their privacy/permission declarations
   (mic usage strings, data-safety forms — note: audio leaves the device to
   Groq/OpenRouter).

## Docs site (this folder)

- Docusaurus 3.9 + `@freemocap/skellydocs` theme + mermaid.
- `npm install && npm start` inside `glossa-docs/` to develop;
  `npm run build` to emit static site.
- **Deploy config is placeholder** (`docusaurus.config.ts`: `url:
  https://github.com`, `baseUrl: /glossa/`). For GitHub Pages:
  set `url: https://jonmatthis.github.io`, keep `baseUrl: /glossa/`, and add
  a Pages workflow (or point it at a custom domain).
- Sidebar is autogenerated (`sidebars.ts`); docs are ordered by
  `sidebar_position`: intro → overview → architecture → ontology → status →
  platforms.
