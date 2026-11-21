import { structured } from "../llm.js";
import { PhotoDescription } from "../schemas.js";

const describer = structured(PhotoDescription, "site_photo");

const SYSTEM = `You describe construction site photos for a site diary. Be factual and specific: what is shown,
which machines or structures are visible, and any hazard, defect or spill. Quote only text you can actually read.
Do not speculate about causes or who is responsible.`;

/** Describe one photo with Claude vision. `image` is { mime, data (Buffer) }. */
export async function describePhoto({ mime, data }, hint) {
  return describer.invoke([
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: mime, data: data.toString("base64") } },
        { type: "text", text: hint ? `The person who took it said: "${hint}"` : "Describe this site photo." },
      ],
    },
  ]);
}

/** One readable passage per photo; this is what is stored as source_passages 'image:<n>' and cited as evidence. */
export function photoPassage(d) {
  const parts = [d.description];
  if (d.visible_assets?.length) parts.push(`Visible: ${d.visible_assets.join(", ")}.`);
  if (d.hazards?.length) parts.push(`Hazards: ${d.hazards.join("; ")}.`);
  if (d.text_in_image?.length) parts.push(`Text in image: ${d.text_in_image.join(" | ")}.`);
  return parts.join(" ");
}
