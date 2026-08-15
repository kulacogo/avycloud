/**
 * Übersetzt Firebase-Anmeldefehler in Sätze, mit denen ein Mensch etwas
 * anfangen kann.
 *
 * Vorher zeigte der Anmeldebildschirm `err.message` — also den rohen
 * englischen Firebase-Text („Firebase: Error (auth/invalid-credential)."). Der
 * gepflegte Satz „Anmeldung fehlgeschlagen." war toter Code, weil `message`
 * immer gesetzt ist.
 *
 * BEWUSST: falsches Passwort und unbekanntes Konto ergeben DENSELBEN Satz.
 * Eine Unterscheidung würde verraten, welche E-Mail-Adressen existieren.
 */

/** Fehlercode → Klartext. Bewusst kurz gehalten und ohne Schuldzuweisung. */
const MELDUNGEN: Record<string, string> = {
  "auth/invalid-credential": "E-Mail-Adresse oder Passwort stimmt nicht.",
  "auth/wrong-password": "E-Mail-Adresse oder Passwort stimmt nicht.",
  "auth/user-not-found": "E-Mail-Adresse oder Passwort stimmt nicht.",
  "auth/invalid-email": "Diese E-Mail-Adresse sieht nicht richtig aus.",
  "auth/missing-password": "Bitte gib dein Passwort ein.",
  "auth/user-disabled": "Dieses Konto ist gesperrt. Wende dich an die Leitung.",
  "auth/too-many-requests": "Zu viele Versuche. Bitte warte einen Moment und versuch es später erneut.",
  "auth/network-request-failed": "Keine Verbindung zum Server. Prüf bitte dein Netz.",
};

/** Erkennt den technischen Rohtext, der nie beim Menschen ankommen darf. */
const IST_ROHTEXT = /^Firebase:|auth\/[a-z-]+/i;

export function authErrorMessage(error: { code?: string; message?: string } | null | undefined, fallback: string): string {
  if (!error) return fallback;

  const code = typeof error.code === "string" ? error.code : "";
  if (code && MELDUNGEN[code]) return MELDUNGEN[code];

  const message = typeof error.message === "string" ? error.message.trim() : "";
  // Eigene, bereits verständliche Fehler (z. B. die Domänenprüfung beim
  // Anmelden) tragen keinen Firebase-Code und dürfen durch.
  if (message && !IST_ROHTEXT.test(message)) return message;

  return fallback;
}
