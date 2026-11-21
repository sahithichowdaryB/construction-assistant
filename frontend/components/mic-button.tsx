"use client";

import { Mic, RotateCcw, Square, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type RecState = "idle" | "requesting" | "recording" | "recorded" | "denied" | "unsupported";

const PREFERRED_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mpeg"];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
}

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export interface Recording {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

/**
 * Voice capture skeleton: start / stop, timer, level meter, playback, re-record and cancel.
 * Records webm (Opus) where supported and falls back to mp4 (Safari / iOS).
 */
export function MicButton({ onSubmit, disabled, disabledReason }: { onSubmit: (rec: Recording) => void; disabled?: boolean; disabledReason?: string | null }) {
  const [state, setState] = useState<RecState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const discard = useRef(false);

  const cleanup = useCallback(() => {
    if (timer.current) window.clearInterval(timer.current);
    if (raf.current) cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    void audioCtx.current?.close().catch(() => undefined);
    timer.current = raf.current = null;
    stream.current = null;
    audioCtx.current = null;
    setLevel(0);
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia)) {
      setState("unsupported");
    }
    return cleanup;
  }, [cleanup]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const start = async () => {
    setState("requesting");
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media;
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
      chunks.current = [];
      discard.current = false;
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = () => {
        const duration = Date.now() - startedAt.current;
        cleanup();
        if (discard.current) {
          setState("idle");
          return;
        }
        const type = rec.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunks.current, { type });
        setRecording({ blob, mimeType: type, durationMs: duration });
        setPreviewUrl(URL.createObjectURL(blob));
        setState("recorded");
      };
      recorder.current = rec;

      // Level meter (best effort)
      try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(media).connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
          setLevel(Math.min(1, peak / 64));
          raf.current = requestAnimationFrame(tick);
        };
        audioCtx.current = ctx;
        tick();
      } catch {
        /* meter is optional */
      }

      startedAt.current = Date.now();
      setElapsed(0);
      timer.current = window.setInterval(() => setElapsed(Date.now() - startedAt.current), 250);
      rec.start(250);
      setState("recording");
    } catch {
      cleanup();
      setState("denied");
    }
  };

  const stop = () => recorder.current?.state === "recording" && recorder.current.stop();

  const cancel = () => {
    if (recorder.current?.state === "recording") {
      discard.current = true;
      recorder.current.stop();
    }
    setRecording(null);
    setPreviewUrl(null);
    setElapsed(0);
    setState("idle");
  };

  const recordingNow = state === "recording";
  const bars = 28;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative flex size-44 items-center justify-center">
        {recordingNow && (
          <>
            <span className="absolute inset-4 animate-ping rounded-full bg-red-500/25 [animation-duration:1.6s]" aria-hidden />
            <span className="absolute inset-0 rounded-full bg-red-500/10 transition-transform" style={{ transform: `scale(${0.8 + level * 0.3})` }} aria-hidden />
          </>
        )}
        {!recordingNow && state !== "recorded" && <span className="absolute inset-6 rounded-full bg-primary/15" aria-hidden />}
        <button
          type="button"
          onClick={recordingNow ? stop : start}
          disabled={disabled || state === "requesting" || state === "unsupported" || state === "recorded"}
          aria-pressed={recordingNow}
          aria-label={recordingNow ? "Stop recording" : "Start recording"}
          className={cn(
            "relative flex size-28 items-center justify-center rounded-full shadow-[0_10px_30px_-8px_rgba(255,196,0,0.55)] transition active:scale-95 focus-visible:ring-4 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-40",
            recordingNow ? "bg-red-600 text-white shadow-[0_10px_30px_-8px_rgba(220,38,38,0.6)] hover:bg-red-700" : "bg-primary text-primary-foreground hover:brightness-95",
          )}
        >
          {recordingNow ? <Square className="size-9 fill-current" aria-hidden /> : <Mic className="size-11" aria-hidden />}
        </button>
      </div>

      <div className="flex h-10 items-center gap-[3px]" aria-hidden>
        {Array.from({ length: bars }).map((_, i) => {
          const shape = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.9));
          const h = Math.round(recordingNow ? 4 + level * 34 * shape : 4 + 6 * shape);
          return <span key={i} className={cn("w-[3px] rounded-full transition-[height] duration-100", recordingNow ? "bg-red-400" : "bg-current opacity-25")} style={{ height: `${h}px` }} />;
        })}
      </div>

      <p className="text-sm tabular-nums opacity-80" aria-live="polite">
        {state === "idle" && (disabled ? disabledReason : "Tap to start recording")}
        {state === "requesting" && "Waiting for microphone permission…"}
        {state === "recording" && <span className="font-semibold text-red-400">● Recording {fmt(elapsed)} · tap to stop</span>}
        {state === "recorded" && recording && `Recorded ${fmt(recording.durationMs)}`}
        {state === "denied" && "Microphone permission was denied. Use “Type instead”."}
        {state === "unsupported" && "Recording is not supported in this browser. Use “Type instead”."}
      </p>

      {recordingNow && (
        <Button variant="ghost" size="touch" className="text-current hover:bg-white/10 hover:text-current" onClick={cancel}>
          <Trash2 aria-hidden /> Cancel
        </Button>
      )}

      {state === "recorded" && recording && (
        <div className="flex w-full flex-col items-center gap-2">
          {previewUrl && (
            <audio controls src={previewUrl} className="w-full max-w-sm rounded-full">
              <track kind="captions" />
            </audio>
          )}
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              variant="ghost"
              size="touch"
              className="bg-white/10 text-current hover:bg-white/15 hover:text-current"
              onClick={() => {
                cancel();
                void start();
              }}
            >
              <RotateCcw aria-hidden /> Re-record
            </Button>
            <Button variant="ghost" size="touch" className="text-current hover:bg-white/10 hover:text-current" onClick={cancel}>
              <Trash2 aria-hidden /> Discard
            </Button>
            <Button size="touch" onClick={() => onSubmit(recording)} disabled={disabled}>
              <Upload aria-hidden /> Send recording
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
