/**
 * Versandetikett drucken — ohne die Klickerei über Androids Menüs.
 *
 * Bisher öffnete das Pack-Modul das Etikett-PDF in einem neuen Tab. Auf dem
 * Handscanner war Drucken damit sechs Schritte weit weg: Fenster in den
 * Hintergrund, wieder öffnen, Drei-Punkte-Menü, Teilen, Drucken, Druck-Symbol.
 *
 * Android bietet dafür einen direkten Weg: die Teilen-Funktion des Browsers
 * (`navigator.share` mit Datei). Jede Android-Druck-App ist dort als Ziel
 * eingetragen — aus sechs Schritten werden zwei (Antippen, Drucker wählen).
 *
 * Am Schreibtisch gibt es die Teilen-Funktion meist nicht; dort druckt der
 * eingebettete Rahmen wie bisher direkt.
 */

export type LabelPrintPath = 'share' | 'iframe' | 'tab';

export interface LabelPrintCapabilities {
  /** Browser kann Dateien teilen (Android Chrome, iOS Safari). */
  canShareFiles: boolean;
  /** Zeigt der Browser PDFs in einem eingebetteten Rahmen? (Desktop ja, Android nein.) */
  canPrintPdfInFrame: boolean;
}

/**
 * Wählt den Druckweg. Reine Entscheidung, damit sie ohne Browser prüfbar ist.
 *
 * Teilen gewinnt IMMER, wenn verfügbar: es ist auf dem Handscanner der einzige
 * Weg, der ohne Menü-Klickerei bei einem echten Drucker landet.
 */
export function chooseLabelPrintPath(caps: LabelPrintCapabilities): LabelPrintPath {
  if (caps.canShareFiles) return 'share';
  if (caps.canPrintPdfInFrame) return 'iframe';
  return 'tab';
}

/** Prüft die Fähigkeiten des laufenden Browsers. */
export function detectLabelPrintCapabilities(): LabelPrintCapabilities {
  const nav = typeof navigator === 'undefined' ? null : (navigator as Navigator & {
    canShare?: (data?: unknown) => boolean;
    share?: (data?: unknown) => Promise<void>;
  });
  let canShareFiles = false;
  try {
    if (nav?.share && typeof nav.canShare === 'function' && typeof File !== 'undefined') {
      const probe = new File([new Blob([''], { type: 'application/pdf' })], 'probe.pdf', {
        type: 'application/pdf',
      });
      canShareFiles = nav.canShare({ files: [probe] });
    }
  } catch {
    canShareFiles = false;
  }

  // Android-Chrome stellt PDFs in einem eingebetteten Rahmen NICHT dar — dort
  // würde der Druckbefehl auf eine leere Seite laufen.
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
  const istAndroid = /Android/i.test(ua);

  return { canShareFiles, canPrintPdfInFrame: !istAndroid };
}

export interface LabelPrintResult {
  ok: boolean;
  path: LabelPrintPath;
  /** true, wenn der Mensch den Vorgang selbst abgebrochen hat (kein Fehler). */
  cancelled?: boolean;
  error?: string;
}

/**
 * Druckt das Etikett auf dem besten verfügbaren Weg.
 *
 * MUSS aus einem Antippen heraus aufgerufen werden — die Teilen-Funktion
 * verlangt eine Nutzer-Geste und wirft sonst.
 */
export async function printLabelBlob(
  blob: Blob,
  filename: string,
  caps: LabelPrintCapabilities = detectLabelPrintCapabilities()
): Promise<LabelPrintResult> {
  const path = chooseLabelPrintPath(caps);

  if (path === 'share') {
    try {
      const file = new File([blob], filename, { type: blob.type || 'application/pdf' });
      await (navigator as Navigator & { share: (d: unknown) => Promise<void> }).share({
        files: [file],
        title: filename,
      });
      return { ok: true, path: 'share' };
    } catch (err: unknown) {
      const name = (err as { name?: string })?.name || '';
      // Abbruch durch den Menschen ist kein Fehler — nicht in einen anderen
      // Weg ausweichen, sonst springt unerwartet ein Tab auf.
      if (name === 'AbortError') return { ok: false, path: 'share', cancelled: true };
      // Teilen nicht möglich → auf den Tab-Weg zurückfallen.
      return openInTab(blob);
    }
  }

  if (path === 'iframe') {
    try {
      await printViaHiddenFrame(blob);
      return { ok: true, path: 'iframe' };
    } catch {
      return openInTab(blob);
    }
  }

  return openInTab(blob);
}

function openInTab(blob: Blob): LabelPrintResult {
  try {
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Erst nach Minuten freigeben — der Tab braucht die Adresse noch.
    window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    return { ok: true, path: 'tab' };
  } catch (err: unknown) {
    return { ok: false, path: 'tab', error: (err as Error)?.message || 'Etikett konnte nicht geöffnet werden' };
  }
}

function printViaHiddenFrame(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0';
    iframe.src = url;
    document.body.appendChild(iframe);

    const aufraeumen = () => {
      window.setTimeout(() => {
        try { iframe.remove(); } catch { /* Aufräumen darf scheitern */ }
        try { URL.revokeObjectURL(url); } catch { /* dito */ }
      }, 60_000);
    };

    let fertig = false;
    const drucken = () => {
      if (fertig) return;
      fertig = true;
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
        aufraeumen();
        resolve();
      } catch (err) {
        aufraeumen();
        reject(err);
      }
    };

    iframe.onload = drucken;
    // Sicherheitsnetz, falls onload nicht feuert.
    window.setTimeout(drucken, 2000);
  });
}
