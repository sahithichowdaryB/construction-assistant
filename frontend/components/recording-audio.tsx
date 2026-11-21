"use client";

import { useEffect, useState } from "react";
import { toPlayableUrl } from "@/lib/audio";

/**
 * Audio player for MediaRecorder output. Chrome records webm without a duration, which breaks <audio>, so the
 * clip is converted to WAV in the browser first (see lib/audio.ts). If conversion fails, the original is used.
 */
export function RecordingAudio({ src, className }: { src: string; className?: string }) {
  const [playable, setPlayable] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setPlayable(null);
    setFailed(false);
    toPlayableUrl(src, controller.signal)
      .then((url) => {
        objectUrl = url;
        if (controller.signal.aborted) URL.revokeObjectURL(url);
        else setPlayable(url);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (!playable && !failed) return <p className="text-sm opacity-70">Preparing audio…</p>;

  return (
    <audio controls preload="metadata" src={playable ?? src} className={className}>
      <track kind="captions" />
    </audio>
  );
}
