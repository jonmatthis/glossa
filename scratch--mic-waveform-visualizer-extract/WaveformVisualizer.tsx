import { useEffect, useRef, useState } from 'react';

interface AudioWaveformVisualizerProps {
    analyserNode: AnalyserNode | null;
    height?: number;
    backgroundColor?: string;
    waveColor?: string;
    lineWidth?: number;
    timelineSeconds?: number;
}

/**
 * Scrolling real-time waveform visualizer.
 * Draws the literal time-domain waveform (oscilloscope) from an AnalyserNode.
 *
 * Extracted from ultraskelly-ui-og/src/components/VoiceAgent/WaveformVisualizer.tsx
 * (commits 06647d0 "nice wiggles" -> 2ede473 "stremin").
 *
 * Source-agnostic: hand it ANY AnalyserNode (microphone, playback, etc.) and it
 * will draw that audio's actual waveform. No dependencies beyond React + Web Audio.
 */
export function AudioWaveformVisualizer({
    analyserNode,
    height = 150,
    backgroundColor = '#1a1a2e',
    waveColor = '#00ff88',
    lineWidth = 2,
    timelineSeconds = 10,
}: AudioWaveformVisualizerProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const animationFrameRef = useRef<number | null>(null);
    const waveformHistoryRef = useRef<number[]>([]);
    const [isAnimating, setIsAnimating] = useState<boolean>(false);

    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || !analyserNode) {
            setIsAnimating(false);
            return;
        }

        const canvasContext = canvas.getContext('2d');
        if (!canvasContext) {
            console.error('Failed to get canvas 2D context');
            return;
        }

        analyserNode.fftSize = 2048;
        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);

        const resizeCanvas = (): void => {
            if (!canvas || !container) return;

            const width = container.clientWidth;
            const pixelRatio = window.devicePixelRatio || 1;

            canvas.width = width * pixelRatio;
            canvas.height = height * pixelRatio;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
            canvasContext.scale(pixelRatio, pixelRatio);
        };

        resizeCanvas();
        setIsAnimating(true);

        const drawWaveform = (): void => {
            if (!canvas || !container) return;

            const width = container.clientWidth;

            // Get current audio data (the literal waveform samples)
            analyserNode.getByteTimeDomainData(dataArray);

            // Sample ~100 points per frame to keep history bounded
            const samplingRate = Math.max(1, Math.floor(bufferLength / 100));

            for (let i = 0; i < bufferLength; i += samplingRate) {
                const normalized = ((dataArray[i] ?? 128) - 128) / 128.0;
                waveformHistoryRef.current.push(normalized);
            }

            // Max history length so the waveform scrolls across the timeline
            const samplesPerSecond = (60 * 100) / samplingRate; // ~60fps * samples per frame
            const maxSamples = Math.floor(timelineSeconds * samplesPerSecond);

            if (waveformHistoryRef.current.length > maxSamples) {
                waveformHistoryRef.current = waveformHistoryRef.current.slice(-maxSamples);
            }

            // Clear canvas
            canvasContext.fillStyle = backgroundColor;
            canvasContext.fillRect(0, 0, width, height);

            // Timeline grid
            canvasContext.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            canvasContext.lineWidth = 1;

            const pixelsPerSecond = width / timelineSeconds;
            for (let i = 0; i <= timelineSeconds; i++) {
                const x = width - (i * pixelsPerSecond);
                canvasContext.beginPath();
                canvasContext.moveTo(x, 0);
                canvasContext.lineTo(x, height);
                canvasContext.stroke();

                if (i > 0) {
                    canvasContext.fillStyle = 'rgba(255, 255, 255, 0.3)';
                    canvasContext.font = '10px monospace';
                    canvasContext.fillText(`-${i}s`, x + 2, 12);
                }
            }

            // Horizontal center line
            canvasContext.beginPath();
            canvasContext.moveTo(0, height / 2);
            canvasContext.lineTo(width, height / 2);
            canvasContext.stroke();

            // Scrolling waveform
            if (waveformHistoryRef.current.length > 1) {
                canvasContext.strokeStyle = waveColor;
                canvasContext.lineWidth = lineWidth;
                canvasContext.beginPath();

                const pixelsPerSample = width / maxSamples;
                const historyLength = waveformHistoryRef.current.length;

                for (let i = 0; i < historyLength; i++) {
                    const amplitude = waveformHistoryRef.current[i] ?? 0;
                    const x = width - (historyLength - i) * pixelsPerSample;
                    const y = height / 2 - (amplitude * height * 0.45);

                    if (i === 0) {
                        canvasContext.moveTo(x, y);
                    } else {
                        canvasContext.lineTo(x, y);
                    }
                }

                canvasContext.stroke();
            }

            // "now" indicator line
            canvasContext.strokeStyle = 'rgba(255, 0, 0, 0.6)';
            canvasContext.lineWidth = 2;
            canvasContext.beginPath();
            canvasContext.moveTo(width - 1, 0);
            canvasContext.lineTo(width - 1, height);
            canvasContext.stroke();

            animationFrameRef.current = requestAnimationFrame(drawWaveform);
        };

        drawWaveform();

        const handleResize = (): void => {
            resizeCanvas();
        };
        window.addEventListener('resize', handleResize);

        return (): void => {
            if (animationFrameRef.current !== null) {
                cancelAnimationFrame(animationFrameRef.current);
                animationFrameRef.current = null;
            }
            window.removeEventListener('resize', handleResize);
            setIsAnimating(false);
            waveformHistoryRef.current = [];
        };
    }, [analyserNode, height, backgroundColor, waveColor, lineWidth, timelineSeconds]);

    return (
        <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
            <canvas
                ref={canvasRef}
                style={{
                    display: 'block',
                    border: '1px solid #444',
                    borderRadius: '8px',
                    width: '100%',
                }}
            />
            {!analyserNode && (
                <div
                    style={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        color: '#888',
                        fontSize: '14px',
                    }}
                >
                    No audio playing
                </div>
            )}
            {isAnimating && (
                <div
                    style={{
                        position: 'absolute',
                        top: '8px',
                        right: '8px',
                        color: waveColor,
                        fontSize: '10px',
                        opacity: 0.6,
                        backgroundColor: 'rgba(0, 0, 0, 0.5)',
                        padding: '4px 8px',
                        borderRadius: '4px',
                    }}
                >
                    🎵 Recording
                </div>
            )}
        </div>
    );
}
