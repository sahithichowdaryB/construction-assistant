/**
 * MediaRecorder output (webm/Opus in Chrome) has no duration or seek index, so <audio> often shows 0:00 and
 * won't play it. We decode the recording in the browser and re-encode it as a plain 16-bit PCM WAV, which every
 * browser plays and seeks reliably.
 */
function encodeWav(buffer: AudioBuffer): Blob {
  const { numberOfChannels, sampleRate, length } = buffer;
  const channels = Array.from({ length: numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const data = new DataView(new ArrayBuffer(44 + length * 2));
  const text = (offset: number, s: string) => [...s].forEach((ch, i) => data.setUint8(offset + i, ch.charCodeAt(0)));

  text(0, "RIFF");
  data.setUint32(4, 36 + length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); // PCM
  data.setUint16(22, 1, true); // mono (channels are mixed down)
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, "data");
  data.setUint32(40, length * 2, true);

  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const ch of channels) sum += ch[i];
    const v = Math.max(-1, Math.min(1, sum / numberOfChannels));
    data.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([data], { type: "audio/wav" });
}

/** Fetches `src`, decodes it and returns an object URL of an equivalent WAV. The caller revokes the URL. */
export async function toPlayableUrl(src: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(src, { signal });
  if (!res.ok) throw new Error(`Could not load the recording (HTTP ${res.status})`);
  const bytes = await res.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(bytes);
    return URL.createObjectURL(encodeWav(decoded));
  } finally {
    void ctx.close().catch(() => undefined);
  }
}
