# Microphone Waveform Visualizer (extracted)

A scrolling, real-time oscilloscope that draws the **literal time-domain waveform**
of your microphone input. Self-contained, zero npm dependencies beyond React +
the browser Web Audio API.

## Provenance

Extracted from this repo's `ultraskelly-ui-og` (the "OG" Vite UI). Git lineage:

| Commit | Message | What happened |
|--------|---------|---------------|
| `06647d0` | "nice wiggles" | First version — real-time waveform, non-scrolling |
| `2ede473` | "stremin" | Added scrolling 10s timeline, time grid, red "now" line, "Recording" badge |
| `608791c` | "change the name" | `ultraskelly-ts` → `ultraskelly-ui` |
| `8585e6d` | "max len q" | Moved to `ultraskelly-ui-og` |
| `1ae2b8d` | "ui" | Deleted VoiceAgent folder from the current Next.js `ultraskelly-ui` |

## Files

- `WaveformVisualizer.tsx` — the canvas component (verbatim from the OG app, lightly commented).
- `useMicrophoneWaveform.ts` — a small hook that wires `getUserMedia` → `AnalyserNode`.

## Important nuance (why this is "mic" and not "assistant")

In the original OG app, the visualizer's `AnalyserNode` was fed by the
**assistant's playback audio**, not the mic — the mic went through a separate
`AudioWorklet` straight to the OpenAI Realtime API. The visualizer itself is
source-agnostic (`getByteTimeDomainData` just reads whatever flows through the
node), so to get the **microphone** waveform you remember, the included
`useMicrophoneWaveform` hook wires `getUserMedia` into the analyser directly.

## Integration

Copy both files into your project and use:

```tsx
import { AudioWaveformVisualizer } from './WaveformVisualizer';
import { useMicrophoneWaveform } from './useMicrophoneWaveform';

export function MicWaveform() {
  const { analyserNode, isCapturing, error, start, stop } = useMicrophoneWaveform();

  return (
    <div>
      <button onClick={isCapturing ? stop : start}>
        {isCapturing ? 'Stop' : 'Start mic'}
      </button>
      {error && <div>⚠️ {error}</div>}

      <AudioWaveformVisualizer
        analyserNode={analyserNode}
        height={150}
        timelineSeconds={10}
        waveColor="#00ff88"
        backgroundColor="#1a1a2e"
      />
    </div>
  );
}
```

## Requirements / gotchas

- `navigator.mediaDevices.getUserMedia` needs a **secure context** (https:// or localhost).
- Requires a browser with Web Audio (`AnalyserNode`, `MediaStreamAudioSourceNode`).
- The visualizer calls `analyserNode.fftSize = 2048` internally, overriding the hook's value.
- To show a *different* source (e.g. assistant playback), skip the hook and pass any
  `AnalyserNode` whose input is connected to that source.
