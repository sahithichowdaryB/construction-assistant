"use client";

import { Capacitor, registerPlugin } from "@capacitor/core";
import type { MouseEvent } from "react";

const projectDownloads = registerPlugin<{ save(options: { url: string; filename: string }): Promise<void> }>("ProjectDownloads");

/** Give Android a file it can save with the current project session. Other browsers use the anchor. */
export function downloadOnAndroid(event: MouseEvent<HTMLAnchorElement>) {
  if (Capacitor.getPlatform() !== "android" || !Capacitor.isPluginAvailable("ProjectDownloads")) return;
  event.preventDefault();
  const { href, download } = event.currentTarget;
  void projectDownloads.save({ url: href, filename: download }).catch(() => {
    window.alert("The file could not be saved. Check your connection and try again.");
  });
}
