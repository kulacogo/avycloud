import React from "react";
import { listProductNotes, addProductNote, markProductNotesSeen, type ProductNote } from "../api/client";

const fmt = (iso: string) => {
  try {
    return new Date(iso).toLocaleString("de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

const initials = (name?: string | null, email?: string | null) => {
  const src = (name || email || "?").trim();
  return src.charAt(0).toUpperCase();
};

export const ProductNotes: React.FC<{ productId: string; onCountChange?: (n: number) => void }> = ({ productId, onCountChange }) => {
  const [notes, setNotes] = React.useState<ProductNote[]>([]);
  const [text, setText] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!productId) return;
    setError(null);
    setLoading(true);
    try {
      const loaded = await listProductNotes(productId);
      setNotes(loaded);
      onCountChange?.(loaded.length);
      // Notizen wurden angezeigt → fuer diesen Nutzer als gesehen markieren.
      // Die Produkttabelle hoert auf das Event und stellt "Ungelesen" sofort um.
      markProductNotesSeen(productId)
        .then((seenAt) => {
          window.dispatchEvent(
            new CustomEvent("avy:notes-seen", { detail: { productId, seenAt: seenAt || new Date().toISOString() } })
          );
        })
        .catch(() => {});
    } catch (e: any) {
      setError(e?.message || "Notizen konnten nicht geladen werden");
    } finally {
      setLoading(false);
    }
  }, [productId, onCountChange]);

  React.useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    const clean = text.trim();
    if (!clean) return;
    setSaving(true);
    setError(null);
    try {
      await addProductNote(productId, clean);
      setText("");
      await load();
    } catch (e: any) {
      setError(e?.message || "Notiz konnte nicht gespeichert werden");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="p-5 bg-app-surface border border-app-border rounded-2xl space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-txt-muted uppercase tracking-wide">Interne Notizen</h3>
        <p className="text-xs text-txt-muted mt-1">
          Nur für das Team sichtbar. Diese Notizen sind <strong>niemals</strong> Teil der Marktplatz-Angebote.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/20 bg-danger-dim px-4 py-3 text-sm text-danger">{error}</div>
      )}

      {/* Eingabe */}
      <div className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Notiz schreiben… (z. B. Karton beschädigt, Ersatz bestellt)"
          rows={3}
          className="w-full rounded-xl bg-app-bg/60 border border-app-border px-3 py-2.5 text-sm text-txt-primary outline-none focus:border-accent resize-y"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={saving || !text.trim()}
            className="rounded-xl bg-accent hover:bg-accent/80 disabled:opacity-60 px-4 py-2 text-sm font-semibold text-txt-primary"
          >
            {saving ? "Speichere…" : "Notiz hinzufügen"}
          </button>
        </div>
      </div>

      {/* Liste */}
      {loading ? (
        <div className="text-sm text-txt-muted">Lade…</div>
      ) : notes.length === 0 ? (
        <div className="text-sm text-txt-muted">Noch keine Notizen zu diesem Produkt.</div>
      ) : (
        <ul className="space-y-3">
          {notes.map((n) => (
            <li key={n.id} className="flex gap-3">
              <div className="shrink-0 w-8 h-8 rounded-full bg-app-elevated flex items-center justify-center text-xs font-semibold text-txt-secondary">
                {initials(n.userName, n.userEmail)}
              </div>
              <div className="min-w-0 flex-1 rounded-xl border border-app-border bg-app-bg/40 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-txt-primary truncate">{n.userName || n.userEmail || "Unbekannt"}</span>
                  <span className="text-[11px] text-txt-muted shrink-0">{fmt(n.createdAt)}</span>
                </div>
                <p className="text-sm text-txt-secondary whitespace-pre-wrap mt-0.5">{n.text}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
