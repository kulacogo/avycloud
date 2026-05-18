---
title: Chat Assistant (Produkt-Chat)
for: [user, dev, admin]
lastReviewed: 2026-05-18
---

## Zweck

Konversationeller Produkt-Assistant, eingebettet im [ProductSheet](product-sheet.md). Beantwortet Fragen zum Produkt, holt Web-Evidence (eBay, Amazon, Hersteller-Sites, GTIN-Lookup), schlägt Datasheet-Änderungen vor (`change`-Intent) und persistiert sie via `update_datasheet`-Tool. SSE-Streaming-Pipeline mit drei Kaskaden-Stufen: **V3 (Gemini 3.1 Pro Customtools, default)** → **V2 (Grounding + Functions)** → **Legacy (BrightData/SerpAPI)**.

## Komponente(n)

- [components/GeminiChat.tsx](../../../components/GeminiChat.tsx) — Top-Level-Chat-Container, hält `useChatStream`-State, koordiniert `ChatContainer` + `ChatInput`.
- [components/chat/ChatContainer.tsx](../../../components/chat/ChatContainer.tsx) — Message-Liste mit Auto-Scroll.
- [components/chat/ChatInput.tsx](../../../components/chat/ChatInput.tsx) — Text-Input + Attachment-Picker (`ChatInputAttachment`).
- [components/chat/MessageBubble.tsx](../../../components/chat/MessageBubble.tsx) — Einzelne Message-Darstellung (User/Assistant/Tool/Thinking).
- [components/chat/AttachmentMessage.tsx](../../../components/chat/AttachmentMessage.tsx) — Anhang-Darstellung (Bilder, Files).
- [components/chat/FileAttachmentPreview.tsx](../../../components/chat/FileAttachmentPreview.tsx) — Vorschau im Input.

## API-Calls

Indirekt über [hooks/useChatStream.ts](../../../hooks/useChatStream.ts):
- `startChatStream(payload)` ([api/client.ts](../../../api/client.ts)) — POST `/api/chat/...` mit SSE-Response. Liefert `StreamEvent`-Sequenz: `start | thinking | grounding | tool_start | tool_done | needs_human | result | done | error`.
- `getChatSession(productId)` — Session-Snapshot (Historie).
- `clearChatSession(productId)` — Session reset.
- `buildImageProxyUrl(url)` — Bild-Proxy für Web-Bilder.

Pipeline-Routing (Backend-Seite, siehe CLAUDE.md Chat-Assistant-Architektur):
- `?pipeline=v3|v2|legacy|auto` (default `auto` → V3 → V2 → Legacy Fallback-Chain).
- V3-Default seit Code-Default `chatV3Enabled()` in `product-chat-v3.js:80` (siehe CLAUDE.md, Stand 2026-05-10).

Pro-Endpunkt-Doku: `docs/kb/09-api/chat.md` (TBD).

## Datenquellen

- `useChatStream` ([hooks/useChatStream.ts](../../../hooks/useChatStream.ts)) — Single-State-Container für die laufende Session: `events`, `result: ChatAssistantPayload | null`, `isStreaming`, `error`, `thoughts`, `groundingUrls`, `needsHuman`, `pipeline`.
- `ChatAssistantEvidence`-Typ aus [api/client.ts](../../../api/client.ts) — strukturiertes Evidence-Objekt pro Field (Brand, GTIN, …) mit Source-URL + Confidence.
- `Product` als Input-Kontext, `DatasheetChange[]`, `ProductImage[]`, `SerpInsight[]` werden zwischen ProductSheet und Chat geteilt.
- GTIN-Validation: `normalizeBarcode`, `isValidGtin`.

## Wichtige Edge-Cases

- **Empty-State**: leere Konversation → Suggestion-Chips (predefined Prompts).
- **Loading / Streaming**: `isStreaming === true` → Eingabe disabled, Thinking-Bubble sichtbar, Grounding-URLs werden inkrementell gerendert.
- **Error**: `error`-State im Hook → Fehler-Bubble; bei `needs_human`-Event → CTA mit Suggestions.
- **Pipeline-Fallback**: bei Error in V3 fällt der Backend automatisch auf V2 zurück; bei V2-Error auf Legacy. `pipeline`-Feld im `result`-Event zeigt die tatsächlich-genutzte Pipeline an.
- **Confidence-Thresholds** (siehe CLAUDE.md): GTIN 0.95, category 0.85, brand 0.90, mpn 0.85, title 0.70, description 0.60, requiredAspects 0.80, price 0.70, weight 0.70, gpsr 0.75. Unter Threshold → kein Auto-Persist, nur Vorschlag.
- **Persistenz**: `update_datasheet`-Tool wird ausschließlich vom Modell selbst gerufen; UI bekommt das Ergebnis als `DatasheetChange[]` und zeigt es im ProductSheet-Diff.
- **Mobile**: ChatContainer ist responsiv; auf Mobile als Full-Height-Sheet.

## Bekannte Issues

- [TASKS.md](../../../TASKS.md) — **BUG-087** Chat findet keine Web-Bilder über predefined Prompt (P1, offen).
- **BUG-088** Identify/Improve fügen keine Produktbilder aus dem Web hinzu (P1, offen) — verwandt mit Chat-Web-Image-Handling.
- **BUG-094** Chat-Kategorien werden nach Sekunden wieder überschrieben + veraltete eBay-Kategorien (P1, offen).
- **CLAUDE.md Chat-Assistant** — `CHAT_V3=true` ist Code-Default in `product-chat-v3.js:80`. Beim Debuggen Pipeline immer im `result`-Event prüfen (`pipeline: 'v3' | 'v2' | 'legacy'`).
