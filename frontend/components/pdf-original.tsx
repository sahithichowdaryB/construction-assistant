"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { Button } from "@/components/ui/button";

/** Android WebView has no built-in PDF viewer. Render the same authenticated original on a canvas. */
export function PdfOriginal({ url, initialPage, title }: { url: string; initialPage: number; title: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(initialPage);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    let loading: PDFDocumentLoadingTask | undefined;
    async function open() {
      const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
      if (!active) return;
      pdf.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
      loading = pdf.getDocument({ url });
      const doc = await loading.promise;
      if (active) {
        setPageNumber(Math.min(doc.numPages, Math.max(1, initialPage)));
        setDocument(doc);
      }
    }
    open().catch(() => { if (active) setError(true); });
    return () => { active = false; void loading?.destroy(); };
  }, [url, initialPage]);

  useEffect(() => {
    const element = canvas.current;
    if (!document || !element) return;
    let active = true;
    let rendering: RenderTask | undefined;
    const doc = document;
    async function draw(target: HTMLCanvasElement) {
      const page = await doc.getPage(pageNumber);
      if (!active) return;
      const bounds = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(bounds.width, bounds.height)) });
      target.width = Math.ceil(viewport.width);
      target.height = Math.ceil(viewport.height);
      rendering = page.render({ canvas: target, viewport });
      await rendering.promise;
      if (active) setReady(true);
    }
    setReady(false);
    setError(false);
    draw(element).catch(() => { if (active) setError(true); });
    return () => { active = false; rendering?.cancel(); };
  }, [document, pageNumber]);

  return (
    <div className="flex flex-col gap-2">
      {document && document.numPages > 1 && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <Button variant="outline" size="sm" disabled={pageNumber <= 1} onClick={() => setPageNumber(pageNumber - 1)}>Previous</Button>
          <span>Page {pageNumber} of {document.numPages}</span>
          <Button variant="outline" size="sm" disabled={pageNumber >= document.numPages} onClick={() => setPageNumber(pageNumber + 1)}>Next</Button>
        </div>
      )}
      {error ? <p role="alert" className="text-sm">This PDF page could not be displayed. Open or download the original file.</p>
        : !ready && <p role="status" className="text-sm text-muted-foreground">Loading PDF page…</p>}
      <canvas ref={canvas} role="img" aria-label={`${title}, page ${pageNumber}`} className={ready && !error ? "h-auto w-full rounded-lg border bg-white" : "hidden"} />
    </div>
  );
}
