import { useCallback, useEffect, useRef, useState } from 'react';

export interface MicrophoneWaveformResult {
    /** The analyser to pass to <AudioWaveformVisualizer analyserNode={...} />. */
    analyserNode: AnalyserNode | null;
    isCapturing: boolean;
    error: string | null;
    start: () => Promise<void>;
    stop: () => void;
}

export interface MicrophoneWaveformOptions {
    fftSize?: number;
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
}

/**
 * Wires the microphone's literal waveform into an AnalyserNode.
 *
 *   getUserMedia -> AudioContext -> MediaStreamSource -> AnalyserNode
 *
 * The analyser is NOT connected to audioContext.destination, so this never
 * creates a feedback loop — it only measures, never plays back.
 *
 * NOTE: getUserMedia requires a secure context (https:// or localhost).
 *
 * (In the original OG app the analyser was wired to the ASSISTANT's playback
 *  output instead; this hook restores the "literal mic waveform" behaviour.)
 */
export function useMicrophoneWaveform(
    options: MicrophoneWaveformOptions = {},
): MicrophoneWaveformResult {
    const {
        fftSize = 2048,
        echoCancellation = true,
        noiseSuppression = true,
        autoGainControl = true,
    } = options;

    const [analyserNode, setAnalyserNode] = useState<AnalyserNode | null>(null);
    const [isCapturing, setIsCapturing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const streamRef = useRef<MediaStream | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);

    const stop = useCallback((): void => {
        if (analyserRef.current) {
            analyserRef.current.disconnect();
            analyserRef.current = null;
        }
        if (sourceRef.current) {
            sourceRef.current.disconnect();
            sourceRef.current = null;
        }
        if (audioContextRef.current) {
            audioContextRef.current.close().catch(() => {});
            audioContextRef.current = null;
        }
        if (streamRef.current) {
            streamRef.current.getTracks().forEach((track) => track.stop());
            streamRef.current = null;
        }
        setAnalyserNode(null);
        setIsCapturing(false);
    }, []);

    const start = useCallback(async (): Promise<void> => {
        setError(null);
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation,
                    noiseSuppression,
                    autoGainControl,
                },
            });
            streamRef.current = stream;

            const audioContext = new AudioContext();
            audioContextRef.current = audioContext;

            const source = audioContext.createMediaStreamSource(stream);
            sourceRef.current = source;

            const analyser = audioContext.createAnalyser();
            analyser.fftSize = fftSize;
            analyser.smoothingTimeConstant = 0.8;
            analyserRef.current = analyser;

            source.connect(analyser);

            if (audioContext.state === 'suspended') {
                await audioContext.resume();
            }

            setAnalyserNode(analyser);
            setIsCapturing(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unknown microphone error');
            stop();
        }
    }, [echoCancellation, noiseSuppression, autoGainControl, fftSize, stop]);

    // Clean up on unmount.
    useEffect(() => stop, [stop]);

    return { analyserNode, isCapturing, error, start, stop };
}
