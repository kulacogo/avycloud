
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Product, DatasheetChange, ProductImage, SerpInsight } from '../types';
import { buildImageProxyUrl, getChatSession, clearChatSession, ChatAssistantEvidence } from '../api/client';
import { useChatStream, StreamEvent } from '../hooks/useChatStream';
import ChatContainer from './chat/ChatContainer';
import ChatInput, { ChatInputAttachment } from './chat/ChatInput';
import MessageBubble from './chat/MessageBubble';
import { SparklesIcon } from './icons/Icons';
import { useI18n } from '../i18n';
import { normalizeBarcode, isValidGtin } from '../utils/gtin';
import { mergeIncomingDatasheetChanges } from './chatChanges';

interface AssistantChatProps {
  product: Product;
  onApplyDatasheetChange?: (change: DatasheetChange) => void;
  onAddImages?: (images: ProductImage[]) => void;
}

type MessageAttachment = {
  id: string;
  name: string;
  url?: string;
  type?: string;
  size?: number;
  isImage?: boolean;
};

type PendingChange = {
  id: string;
  change: DatasheetChange;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  attachments?: MessageAttachment[];
  datasheetChanges?: PendingChange[];
};

type AttachmentDraft = ChatInputAttachment & { file: File };

type PendingImage = {
  id: string;
  image: ProductImage;
  rationale?: string;
};

type PromptTemplate = {
  key: string;
  label: string;
  value: string;
};

const MAX_ATTACHMENTS = 6;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
]);

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

const isAllowedAttachment = (file: File) => {
  if (!file) return false;
  if (file.type && (ALLOWED_ATTACHMENT_TYPES.has(file.type) || file.type.startsWith('image/'))) {
    return true;
  }
  const lowerName = file.name?.toLowerCase() || '';
  return ['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.txt', '.csv', '.json'].some((ext) => lowerName.endsWith(ext));
};

const sanitizeDatasheetChange = (entry: any = {}): DatasheetChange => {
  const result: DatasheetChange = {};
  // Pass through categoryId/categoryPath from backend (resolved by ebay-taxonomy)
  if (typeof entry.categoryId === 'string' && entry.categoryId.trim()) {
    result.categoryId = entry.categoryId.trim();
  }
  if (typeof entry.categoryPath === 'string' && entry.categoryPath.trim()) {
    result.categoryPath = entry.categoryPath.trim();
  }
  if (typeof entry.summary === 'string') {
    result.summary = entry.summary;
  }
  if (typeof entry.short_description === 'string') {
    result.short_description = entry.short_description;
  }
  if (Array.isArray(entry.key_features)) {
    result.key_features = entry.key_features.filter(Boolean);
  }
  if (entry.gpsr && typeof entry.gpsr === 'object') {
    const next: Record<string, string> = {};
    [
      'entity_country',
      'country_code',
      'manufacturer_name',
      'manufacturer_address',
      'manufacturer_city',
      'manufacturer_postalcode',
      'manufacturer_state_province',
      'email',
      'manufacturer_phone',
      'url',
      'eu_responsible_name',
      'eu_responsible_address',
      'eu_responsible_city',
      'eu_responsible_postalcode',
      'eu_responsible_country',
      'eu_responsible_country_code',
      'eu_responsible_email',
      'eu_responsible_phone',
    ].forEach((k) => {
      const v = typeof entry.gpsr?.[k] === 'string' ? entry.gpsr[k].trim() : '';
      if (v) next[k] = v;
    });
    if (Object.keys(next).length) {
      (result as any).gpsr = next;
    }
  }
  if (entry.attributes) {
    if (Array.isArray(entry.attributes)) {
      // V3 liefert {key, value}, ältere Pipelines {name, value} — beide akzeptieren
      // (nur-name-Einträge wurden früher still verworfen).
      result.attributes = entry.attributes.reduce((acc: Record<string, string | number | boolean>, item: any) => {
        const k = item && typeof item.key === 'string' && item.key.trim()
          ? item.key.trim()
          : (item && typeof item.name === 'string' ? item.name.trim() : '');
        if (k && item.value !== null && item.value !== undefined && typeof item.value !== 'object') {
          acc[k] = item.value;
        }
        return acc;
      }, {});
    } else if (typeof entry.attributes === 'object') {
      result.attributes = entry.attributes;
    }
  }
  if (entry.pricing && typeof entry.pricing === 'object') {
    // V3 liefert Preis FLACH ({amount, currency, source_url}) — normalisieren auf
    // das echte Pricing-Modell (sellPrice = der Preis, den eBay/Kaufland syncen;
    // lowest_price = Anzeige + Quelle). V2/Legacy liefern bereits verschachtelt
    // (lowest_price vorhanden) und laufen unverändert durch.
    const p: any = entry.pricing;
    const flatAmount = typeof p.amount === 'number' && Number.isFinite(p.amount) && p.amount > 0 ? p.amount : null;
    if (flatAmount != null && !p.lowest_price) {
      const currency = typeof p.currency === 'string' && p.currency ? p.currency : 'EUR';
      result.pricing = {
        sellPrice: flatAmount,
        price_confidence: typeof p.confidence === 'number' ? p.confidence : 0.7,
        lowest_price: {
          amount: flatAmount,
          currency,
          sources: typeof p.source_url === 'string' && p.source_url
            ? [{ name: 'KI-Recherche', url: p.source_url, price: flatAmount, checked_at: new Date().toISOString() }]
            : [],
        },
      };
    } else {
      result.pricing = p;
    }
  }
  if (entry.notes && typeof entry.notes === 'object') {
    result.notes = entry.notes;
  }
  const identityPatch: Record<string, any> = {};
  const barcodeSet = new Set<string>();
  const pushBarcode = (value?: string) => {
    if (!value) return;
    const digits = normalizeBarcode(value);
    if (digits && isValidGtin(digits)) {
      barcodeSet.add(digits);
    }
  };
  const normalizeLower = (v?: any) => (v == null ? '' : String(v).trim().toLowerCase());
  const isMarketplaceKey = (key: string) => {
    const k = normalizeLower(key);
    if (!k) return false;
    return k.includes('ebay') || k.includes('kaufland');
  };
  const isBarcodeAttrKey = (key: string) => {
    const k = normalizeLower(key);
    if (!k) return false;
    return (
      k === 'ean' ||
      k === 'gtin' ||
      k === 'upc' ||
      k === 'barcode' ||
      k === 'barcodes' ||
      k === 'ean/gtin' ||
      k.includes('ean') ||
      k.includes('gtin') ||
      k.includes('upc')
    );
  };
  if (Array.isArray(entry.barcodes)) {
    entry.barcodes.forEach((value: string) => pushBarcode(value));
  }
  if (typeof entry.title === 'string' && entry.title.trim()) {
    identityPatch.name = entry.title.trim();
    result.title = entry.title.trim();
  }
  if (entry.identity && typeof entry.identity === 'object') {
    if (typeof entry.identity.title === 'string' && entry.identity.title.trim()) {
      identityPatch.name = entry.identity.title.trim();
    }
    if (typeof entry.identity.name === 'string' && entry.identity.name.trim()) {
      identityPatch.name = entry.identity.name.trim();
    }
    if (typeof entry.identity.brand === 'string' && entry.identity.brand.trim()) {
      identityPatch.brand = entry.identity.brand.trim();
    }
    if (typeof entry.identity.category === 'string' && entry.identity.category.trim()) {
      identityPatch.category = entry.identity.category.trim();
      // Also set categoryPath so applyAssistantChange picks it up for details.categoryId
      if (!result.categoryPath) {
        result.categoryPath = entry.identity.category.trim();
      }
    }
    if (typeof entry.identity.sku === 'string' && entry.identity.sku.trim()) {
      identityPatch.sku = entry.identity.sku.trim();
    }
    if (Array.isArray(entry.identity.barcodes)) {
      entry.identity.barcodes.forEach((value: string) => pushBarcode(value));
    }
    if (typeof entry.identity.gtin === 'string') {
      pushBarcode(entry.identity.gtin);
    }
    if (typeof entry.identity.ean === 'string') {
      pushBarcode(entry.identity.ean);
    }
    if (typeof entry.identity.upc === 'string') {
      pushBarcode(entry.identity.upc);
    }
  }
  if (barcodeSet.size) {
    identityPatch.barcodes = Array.from(barcodeSet);
  }
  // Forward explicit clear directive from the backend (see DatasheetChange.identity._clear).
  // This is the only sanctioned way to delete identifier fields from the chat tool —
  // empty arrays cannot do it because additive merges drop them.
  if (entry.identity && Array.isArray(entry.identity._clear)) {
    const allowed = new Set(['barcodes', 'ean', 'gtin', 'upc']);
    const clear = Array.from(
      new Set(
        entry.identity._clear
          .map((v: any) => normalizeLower(v))
          .filter((v: string) => allowed.has(v))
      )
    );
    if (clear.length) {
      identityPatch._clear = clear;
      // If the assistant asks to clear barcodes, do not also send an empty
      // barcodes array (which the additive consolidator would just drop).
      if (clear.includes('barcodes')) {
        delete identityPatch.barcodes;
      }
    }
  }
  if (Object.keys(identityPatch).length) {
    result.identity = identityPatch;
  }

  // Sanitize attributes: drop marketplace keys; move barcode-like keys into barcodes.
  if (result.attributes && typeof result.attributes === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(result.attributes)) {
      if (!key) continue;
      if (isMarketplaceKey(key)) continue;
      if (isBarcodeAttrKey(key)) {
        pushBarcode(String(value ?? ''));
        continue;
      }
      cleaned[key] = value;
    }
    result.attributes = cleaned;
    if (Object.keys(cleaned).length === 0) {
      delete (result as any).attributes;
    }
    // If we found barcodes via attributes, ensure they end up in identityPatch as well.
    if (barcodeSet.size) {
      result.identity = { ...(result.identity || {}), barcodes: Array.from(barcodeSet) };
    }
  }
  return result;
};

const cleanAssistantMessage = (raw: string) => {
  if (!raw) return '';
  // Remove JSON code blocks (tool output) but keep text code blocks
  let text = raw.replace(/```json[\s\S]*?```/gi, '').replace(/```[\s\S]*?```/g, '');
  // Strip raw HTML tags from LLM output (they render as text otherwise)
  text = text.replace(/<\/?(?:p|ul|ol|li|strong|em|br|div|span|h[1-6])[^>]*>/gi, '');
  // Collapse excessive whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
};

const mapSuggestionsToAttachments = (
  groups: { rationale?: string; images?: ProductImage[] }[] | undefined,
  fallbackLabel: string
): MessageAttachment[] => {
  if (!Array.isArray(groups) || !groups.length) return [];
  const attachments: MessageAttachment[] = [];
  for (const group of groups) {
    // Chat-V3 liefert Query-only-Vorschläge ({query, rationale} ohne images) —
    // die haben hier nichts zu rendern und dürfen nicht crashen.
    const groupImages = Array.isArray(group?.images) ? group.images : [];
    for (const image of groupImages) {
      if (!image?.url_or_base64 || attachments.length >= 4) break;
      attachments.push({
        id: uid(),
        name: group.rationale || image.variant || fallbackLabel,
        url: buildImageProxyUrl(image.url_or_base64),
        type: image.source || 'image/web',
        isImage: true,
      });
    }
  }
  return attachments;
};

type QuickPrompt = {
  icon: string;
  label: string;
  message: string;
  scope: string;
};

const QUICK_PROMPTS: QuickPrompt[] = [
  { icon: '✨', label: 'Alles optimieren', message: 'Optimiere Titel, Beschreibung, Highlights und Attribute. Prüfe außerdem den Verkaufspreis (recherchiere aktuelle Marktpreise — besonders wenn der Preis fehlt oder 0 ist), die Marke sowie die GPSR-Herstellerangaben (Name, Adresse, Kontakt) und schlage fehlende Werte konkret vor. Recherchiere online. Wichtig: Die Beschreibung ist reiner Fließtext ohne Aufzählungen — Bullet Points gehören ausschließlich in die Highlights.', scope: 'title,attributes,highlights,description,pricing,gpsr,datasheet' },
  { icon: '🏷️', label: 'Titel verbessern', message: 'Erstelle einen SEO-optimierten, marketplace-tauglichen Produkttitel basierend auf Online-Recherche. Wichtig: Nur Marke + Produkttyp + Modell + technische Merkmale. KEINE Firmennamen, Rechtsformen (GmbH, Sp. K, Ltd., Inc., S.A., Co. KG), Händlernamen oder Herstelleradressen im Titel.', scope: 'title' },
  { icon: '📝', label: 'Beschreibung', message: 'Schreibe eine professionelle, verkaufsstarke Produktbeschreibung mit Bullet Points und Vorteilen.', scope: 'description,highlights' },
  { icon: '🔍', label: 'EAN / GTIN finden', message: 'Recherchiere die korrekte EAN/GTIN für dieses Produkt im Web.', scope: 'gtin' },
  { icon: '📊', label: 'Attribute', message: 'Ergänze fehlende Produktattribute (Material, Farbe, Maße, Gewicht etc.) basierend auf Online-Recherche.', scope: 'attributes' },
  { icon: '💰', label: 'Preischeck', message: 'Recherchiere aktuelle Marktpreise für dieses Produkt und schlage einen wettbewerbsfähigen Preis vor.', scope: 'pricing' },
  { icon: '🖼️', label: 'Bilder suchen', message: 'Finde passende Produktbilder im Web.', scope: 'images' },
  { icon: '🏭', label: 'GPSR / Hersteller', message: 'Recherchiere Herstellerangaben (Name, Adresse, Kontakt) für die GPSR-Konformität.', scope: 'gpsr' },
];

const TOOL_LABELS: Record<string, string> = {
  // Legacy tools
  brightdata_web_search: 'Websuche',
  serpapi_web_search: 'Websuche',
  web_fetch: 'Seite lesen',
  update_product_datasheet: 'Änderung erstellen',
  suggest_product_images: 'Bilder suchen',
  generate_ai_images: 'KI-Bilder erstellen',
  fallback_legacy: 'Fallback (Legacy)',
  chat_complete: 'Fertig',
  // New atomic tools (V3)
  lookup_gtin: 'GTIN Lookup',
  search_ebay_catalog: 'eBay Katalog',
  get_required_aspects: 'Pflichtmerkmale',
  verify_brand: 'Marke prüfen',
  search_amazon_product: 'Amazon-Recherche',
  search_manufacturer_site: 'Herstellerseite',
  fetch_url_content: 'URL lesen',
  googleSearch: 'Google-Suche',
  urlContext: 'URL-Kontext',
};

const StreamProgressLine: React.FC<{ event: StreamEvent }> = ({ event }) => {
  if (event.type === 'start') {
    return (
      <div className="flex items-center gap-2 text-txt-muted">
        <span className="inline-block h-2 w-2 rounded-full bg-accent animate-pulse" />
        <span>{event.text || 'Starte…'}</span>
      </div>
    );
  }
  if (event.type === 'tool_start') {
    const label = TOOL_LABELS[event.tool] || event.tool;
    const detail = event.query || event.url || '';
    const errorMsg = (event as any).error || '';
    return (
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2 text-txt-secondary">
          <span className={`inline-block h-2 w-2 rounded-full ${errorMsg ? 'bg-danger' : 'bg-amber-400'} animate-pulse`} />
          <span>{label}{detail ? <span className="ml-1 text-txt-muted truncate max-w-[180px] inline-block align-bottom">&quot;{detail}&quot;</span> : null}</span>
        </div>
        {errorMsg && <p className="text-[10px] text-danger/80 pl-4 break-all">{errorMsg}</p>}
      </div>
    );
  }
  if (event.type === 'tool_done') {
    const label = TOOL_LABELS[event.tool] || event.tool;
    const detail = event.count != null ? `${event.count} Ergebnisse` : event.fields != null ? `${event.fields} Felder` : '';
    return (
      <div className="flex items-center gap-2 text-txt-muted">
        <span className="text-success">✓</span>
        <span>{label}{detail ? <span className="ml-1">({detail})</span> : null}</span>
      </div>
    );
  }
  if (event.type === 'thinking') {
    // Rendered separately as accumulated thoughts in a collapsible panel
    return null;
  }
  if (event.type === 'grounding') {
    // Rendered separately as a chip-row of grounding sources
    return null;
  }
  if (event.type === 'needs_human') {
    return (
      <div className="flex items-center gap-2 text-warning">
        <span>⚠️</span>
        <span>Niedrige Konfidenz erkannt</span>
      </div>
    );
  }
  return null;
};

const AssistantChat: React.FC<AssistantChatProps> = ({ product, onApplyDatasheetChange, onAddImages }) => {
  const { t } = useI18n();
  const {
    send: chatSend,
    isStreaming,
    events: streamEvents,
    reset: resetStream,
    result: streamResult,
    thoughts,
    groundingUrls,
    needsHuman,
    pipeline,
  } = useChatStream();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [attachmentDrafts, setAttachmentDrafts] = useState<AttachmentDraft[]>([]);
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [serpInsights, setSerpInsights] = useState<SerpInsight[]>([]);
  const [evidence, setEvidence] = useState<ChatAssistantEvidence[]>([]);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [applyingChangeIds, setApplyingChangeIds] = useState<Set<string>>(new Set());

  const [promptConfig, setPromptConfig] = useState(() => ({
    // What to improve
    title: true,
    attributes: true,
    highlights: true,
    description: true,
    pricing: false,
    gtin: false,
    images: false,
    gpsr: false,
    category: false,
    maxPagesToFetch: 2,
  }));

  const applyPromptScene = useCallback((scene: string) => {
    const base = {
      // default research behavior (always broad web search)
      maxPagesToFetch: 2,
      // default content goals
      title: false,
      attributes: false,
      highlights: false,
      description: false,
      pricing: false,
      gtin: false,
      images: false,
      gpsr: false,
      category: false,
    };

    const next: any = { ...base };
    switch (scene) {
      case 'full':
        next.title = true;
        next.attributes = true;
        next.highlights = true;
        next.description = true;
        break;
      case 'title':
        next.title = true;
        break;
      case 'gtin':
        next.gtin = true;
        break;
      case 'gpsr':
        next.gpsr = true;
        break;
      case 'images':
        next.images = true;
        next.maxPagesToFetch = 3;
        break;
      case 'pricing':
        next.pricing = true;
        break;
      case 'category':
        next.category = true;
        next.attributes = true;
        break;
      default:
        next.title = true;
        next.attributes = true;
        next.highlights = true;
        next.description = true;
        break;
    }

    setPromptConfig((prev) => ({
      ...prev,
      ...next,
    }));
  }, []);

  const chatBodyRef = useRef<HTMLDivElement>(null);
  const suggestionKeysRef = useRef<Set<string>>(new Set());
  const objectUrlStore = useRef<string[]>([]);

  const buildSmartPrompt = useCallback(() => {
    const goals: string[] = [];
    if (promptConfig.title) goals.push('Titel');
    if (promptConfig.attributes) goals.push('Attribute/Parameter');
    if (promptConfig.highlights) goals.push('Highlights');
    if (promptConfig.description) goals.push('Beschreibung');
    if (promptConfig.pricing) goals.push('Preis');
    if (promptConfig.gtin) goals.push('EAN/GTIN/UPC');
    if (promptConfig.images) goals.push('Web-Produktbilder');
    if (promptConfig.gpsr) goals.push('GPSR/Herstellerdaten');
    if (promptConfig.category) goals.push('Kategorie');

    const maxFetch = Math.max(1, Math.min(5, Number(promptConfig.maxPagesToFetch) || 2));

    return [
      'Übergeordnetes Ziel: Produktdaten marketplace-ready machen (faktisch, vollständig, keine erfundenen Angaben).',
      `Ziel (dieser Schritt): ${goals.length ? goals.join(', ') : 'Datenblatt verbessern'}.`,
      'Recherche: breite Websuche (ohne site-Limit; Marktplätze sind nur eine Quelle unter vielen).',
      `Fetch: max. ${maxFetch} Seiten laden.`,
      'Bitte arbeite evidenzbasiert: erst suchen, dann 1–2 passende Seiten laden, dann Änderungen vorschlagen.',
      'Wichtig: Ändere nur die angefragten Felder (z. B. bei Attributen keinen neuen Titel vorschlagen).',
      'Gib Änderungen immer als update_product_datasheet aus (damit ich sie direkt übernehmen kann).',
    ].join(' ');
  }, [promptConfig]);

  const derivedScope = useMemo(() => {
    const keys: Array<keyof typeof promptConfig> = [
      'title',
      'attributes',
      'highlights',
      'description',
      'pricing',
      'gtin',
      'images',
      'gpsr',
      'category',
    ];
    const selected = keys.filter((k) => Boolean((promptConfig as any)[k]));
    if (!selected.length) return 'datasheet';
    const mapped = Array.from(
      new Set(
        selected
          .map((only) => {
            if (only === 'title') return 'title';
            if (only === 'pricing') return 'pricing';
            if (only === 'gtin') return 'gtin';
            if (only === 'description') return 'description';
            if (only === 'highlights') return 'highlights';
            if (only === 'attributes') return 'attributes';
            if (only === 'gpsr') return 'gpsr';
            if (only === 'images') return 'images';
            if (only === 'category') return 'category';
            return '';
          })
          .filter(Boolean)
      )
    );
    if (!mapped.length) return 'datasheet';
    if (mapped.length === 1) return mapped[0];
    return mapped.join(',');
  }, [promptConfig]);

  const normalizeImageKey = (value?: string | null) => {
    if (!value) return null;
    try {
      const parsed = new URL(value);
      return `${parsed.hostname}${parsed.pathname}`.toLowerCase();
    } catch {
      return value.trim().toLowerCase() || null;
    }
  };

  const productImageKeys = useMemo(() => {
    const keys = new Set<string>();
    (product?.details?.images || []).forEach((img) => {
      const raw: unknown = img?.url_or_base64;
      const src = typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof (raw as { url?: unknown }).url === "string" ? (raw as { url: string }).url : null;
      const key = normalizeImageKey(src);
      if (key) keys.add(key);
    });
    return keys;
  }, [product]);

  useEffect(() => {
    suggestionKeysRef.current = new Set(productImageKeys);
  }, [productImageKeys]);

  useEffect(() => {
    const node = chatBodyRef.current;
    if (!node) return;
    const handleScroll = () => {
      const isNearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
      setStickToBottom(isNearBottom);
    };
    node.addEventListener('scroll', handleScroll);
    return () => node.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    if (stickToBottom && chatBodyRef.current) {
      chatBodyRef.current.scrollTo({ top: chatBodyRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, pendingChanges, pendingImages, serpInsights, evidence, stickToBottom, streamEvents, thoughts, groundingUrls, needsHuman]);

  // Load existing conversation history from Firestore on mount.
  //
  // IMPORTANT: We only hydrate from the server if the local message buffer is empty.
  // Otherwise we would clobber:
  //   (a) the most recent assistant message's `datasheetChanges` (the "Übernehmen" button) —
  //       Firestore only persists `{role, text, ts}`, not the structured edit payload, and
  //   (b) optimistic user messages that haven't been flushed yet by the (async, best-effort)
  //       backend `appendMessages` call.
  // We track per-product hydration so switching to a different product still triggers a fresh load.
  const hydratedProductIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!product?.id) return;
    if (hydratedProductIdRef.current === product.id) return;
    if (messages.length > 0) {
      // Local state already has live messages (e.g. came back to this product after
      // navigating away and back); do not blow them away with stale server data.
      hydratedProductIdRef.current = product.id;
      return;
    }
    hydratedProductIdRef.current = product.id;
    getChatSession(product.id).then((res) => {
      if (!res.ok || !res.session) return;
      const session = res.session;
      setSessionId(session.id);
      if (!session.messages?.length) return;
      // Convert stored messages to display format (only show last 10 pairs = 20 messages)
      const loadedMessages: ChatMessage[] = session.messages
        .slice(-20)
        .filter((m) => m.role === 'user' || m.role === 'model')
        .map((m) => ({
          id: uid(),
          role: m.role === 'model' ? 'assistant' : 'user',
          text: m.text,
          timestamp: m.ts,
        }));
      if (loadedMessages.length > 0) {
        // Merge: only replace if local is still empty when the response arrives.
        setMessages((prev) => (prev.length > 0 ? prev : loadedMessages));
      }
    }).catch(() => {
      // Session load is best-effort — don't block the chat
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product?.id]);

  useEffect(
    () => () => {
      objectUrlStore.current.forEach((url) => URL.revokeObjectURL(url));
    },
    []
  );

  const handleFilesAdded = useCallback(
    (files: FileList | File[]) => {
      const incoming = Array.from(files || []);
      if (!incoming.length) return;
      const remainingSlots = MAX_ATTACHMENTS - attachmentDrafts.length;
      if (remainingSlots <= 0) {
        console.warn('Maximale Anzahl an Anhängen erreicht.');
        return;
      }
      const drafts: AttachmentDraft[] = [];
      incoming.slice(0, remainingSlots).forEach((file) => {
        if (!isAllowedAttachment(file)) {
          console.warn(`Nicht unterstützter Dateityp: ${file.name}`);
          return;
        }
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
        if (previewUrl) {
          objectUrlStore.current.push(previewUrl);
        }
        drafts.push({
          id: uid(),
          file,
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          isImage: file.type.startsWith('image/'),
          previewUrl,
        });
      });
      if (drafts.length) {
        setAttachmentDrafts((prev) => [...prev, ...drafts]);
      }
    },
    [attachmentDrafts.length]
  );

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachmentDrafts((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
        objectUrlStore.current = objectUrlStore.current.filter((url) => url !== target.previewUrl);
      }
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const resetSession = () => {
    setMessages([]);
    setPendingChanges([]);
    setPendingImages([]);
    setSerpInsights([]);
    setEvidence([]);
    setAttachmentDrafts([]);
    setSessionId(null);
    resetStream();
    // Clear backend session history (best-effort)
    if (product?.id) {
      clearChatSession(product.id).catch(() => {});
    }
  };

  const handleInsertContext = () => {
    if (!product) return;
    const snippet = JSON.stringify(
      {
        sku: product.identification?.sku,
        brand: product.identification?.brand,
        category: product.identification?.category,
        barcodes: product.identification?.barcodes,
        highlights: product.details?.key_features?.slice(0, 3),
      },
      null,
      2
    );
    setInput((prev) => (prev ? `${prev}\n${snippet}` : snippet));
  };

  const resolveImageSrc = (value: string) => {
    if (!value) return '';
    return buildImageProxyUrl(value);
  };

  const appendPendingChanges = (changes: DatasheetChange[] = []) => {
    const mapped = changes
      .filter((change) => Object.keys(change).length > 0)
      .map((change) => ({ id: uid(), change }));
    if (mapped.length) {
      setPendingChanges((prev) => [...prev, ...mapped]);
    }
    return mapped;
  };

  const appendPendingImages = (suggestions: { rationale?: string; images?: ProductImage[] }[] = []) => {
    if (!Array.isArray(suggestions) || !suggestions.length) return;
    const dedupe = new Set(suggestionKeysRef.current);
    const flattened: PendingImage[] = [];
    suggestions.forEach((group) => {
      const groupImages = Array.isArray(group?.images) ? group.images : [];
      groupImages.forEach((img) => {
        const key = normalizeImageKey(img?.url_or_base64);
        if (!key || dedupe.has(key)) {
          return;
        }
        dedupe.add(key);
        flattened.push({
          id: uid(),
          image: {
            ...img,
            url_or_base64: buildImageProxyUrl(img.url_or_base64),
          },
          rationale: group.rationale,
        });
      });
    });
    if (flattened.length) {
      suggestionKeysRef.current = dedupe;
      setPendingImages((prev) => [...prev, ...flattened]);
    }
  };

  const handleApplyChange = (id: string, change: DatasheetChange) => {
    if (!onApplyDatasheetChange) return;
    if (applyingChangeIds.has(id)) return;
    setApplyingChangeIds((prev) => new Set(prev).add(id));
    try {
      onApplyDatasheetChange(change);
      // Remove from global pending list (bottom panel)
      setPendingChanges((prev) => prev.filter((item) => item.id !== id));
      // Remove from the specific assistant message card list so the UI matches the action
      setMessages((prev) =>
        prev.map((msg) => {
          if (!msg.datasheetChanges?.length) return msg;
          const next = msg.datasheetChanges.filter((entry) => entry.id !== id);
          return next.length === msg.datasheetChanges.length ? msg : { ...msg, datasheetChanges: next };
        })
      );
    } finally {
      setApplyingChangeIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleApplyImage = (id: string) => {
    const match = pendingImages.find((item) => item.id === id);
    if (!match) return;
    onAddImages?.([match.image]);
    setPendingImages((prev) => prev.filter((item) => item.id !== id));
  };

  const handleApplyAllImages = () => {
    if (!pendingImages.length) return;
    onAddImages?.(pendingImages.map((item) => item.image));
    setPendingImages([]);
  };

  const extractStructuredEdits = (message: string): DatasheetChange[] => {
    if (!message) return [];
    const matches = Array.from(message.matchAll(/```json([\s\S]*?)```/gi));
    const edits: DatasheetChange[] = [];
    for (const match of matches) {
      const raw = match[1]?.trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        // Candidate is either 'edit' wrapper, OR the object itself if it has recognized fields
        let candidate = parsed?.edit && typeof parsed.edit === 'object' ? parsed.edit : null;

        if (!candidate) {
          const hasDirectFields = parsed.identity || parsed.barcodes || parsed.ean || parsed.gtin ||
            parsed.title || parsed.short_description || parsed.key_features ||
            parsed.attributes || parsed.pricing || parsed.notes;
          if (hasDirectFields) {
            candidate = parsed;
          }
        }

        if (candidate) {
          const change = sanitizeDatasheetChange(candidate);
          if (Object.keys(change).length) {
            edits.push(change);
          }
        }
      } catch (error) {
        console.warn('Failed to parse structured edit JSON:', error);
      }
    }
    return edits;
  };

  const handleSend = useCallback(
    async (predefinedMessage?: string, scopeOverride?: string | null) => {
      if (isStreaming) return;
      const trimmedInput = (predefinedMessage ?? input).trim();
      if (!trimmedInput && attachmentDrafts.length === 0) return;

      const outgoingDrafts = attachmentDrafts;
      const outgoingFiles = outgoingDrafts.map((draft) => draft.file);
      const userAttachments: MessageAttachment[] = outgoingDrafts.map((draft) => ({
        id: draft.id,
        name: draft.name,
        url: draft.previewUrl,
        type: draft.type,
        size: draft.size,
        isImage: draft.isImage,
      }));

      const timestamp = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: 'user',
          text: trimmedInput || t('chat.ui.attachmentMessage'),
          timestamp,
          attachments: userAttachments,
        },
      ]);
      setInput('');
      setAttachmentDrafts([]);

      const payloadMessage = trimmedInput || 'Bitte analysiere die angehängten Dateien.';
      // Quick prompts provide an explicit scope; free-text messages should not
      // restrict which fields Gemini is allowed to change so the user can ask
      // for anything (e.g. "Kategorie korrigieren") without scope blocking it.
      const scope = scopeOverride !== undefined ? scopeOverride : (predefinedMessage ? derivedScope : null);

      try {
        const data = await chatSend({
          productId: product.id,
          message: payloadMessage,
          attachments: outgoingFiles,
          scope,
        });

        if (!data) {
          throw new Error('Keine Antwort erhalten');
        }

        const assistantAttachments = mapSuggestionsToAttachments(data.imageSuggestions, t('chat.ui.imageAlt'));
        // The backend can surface the SAME edit twice: once as structured
        // data.datasheetChanges and once as a ```json block inside the message
        // text (which extractStructuredEdits parses). Merging both unconditionally
        // produced two identical "Übernehmen" cards for one request. Merge with
        // fallback + content dedup so each change appears exactly once.
        const structuredEdits = extractStructuredEdits(data.message);
        const incomingChanges = mergeIncomingDatasheetChanges(data.datasheetChanges, structuredEdits);
        const linkedChanges = appendPendingChanges(incomingChanges);
        const cleanedMessage = cleanAssistantMessage(data.message);
        const assistantMessage: ChatMessage = {
          id: uid(),
          role: 'assistant',
          text: cleanedMessage || t('chat.ui.newSuggestions'),
          timestamp: new Date().toISOString(),
          attachments: assistantAttachments,
          datasheetChanges: linkedChanges,
        };
        setMessages((prev) => [...prev, assistantMessage]);

        appendPendingImages(data.imageSuggestions);
        setSerpInsights(data.serpTrace || []);
        setEvidence(Array.isArray(data.evidence) ? data.evidence : []);
      } catch (error: any) {
        setMessages((prev) => [
          ...prev,
          {
            id: uid(),
            role: 'assistant',
            text: `${t('chat.ui.errorPrefix')} ${error?.message || t('chat.ui.errorFallback')}`,
            timestamp: new Date().toISOString(),
          },
        ]);
        setAttachmentDrafts(outgoingDrafts);
      }
    },
    [attachmentDrafts, chatSend, derivedScope, input, isStreaming, product.id, t]
  );

  return (
    <ChatContainer onFilesDropped={handleFilesAdded}>
      <header className="flex items-center justify-between border-b border-app-border/60 px-4 py-2">
        <div className="flex items-center gap-2">
          <SparklesIcon className="h-4 w-4 text-accent" />
          <span className="font-semibold text-sm text-txt-primary">{t('chat.header.title')}</span>
          <span className="text-[10px] text-txt-muted font-medium tracking-wide">{t('chat.header.subtitle')}</span>
          {pipeline && (
            <span className="ml-2 rounded-full bg-app-elevated/50 border border-app-border/30 px-2 py-0.5 text-[9px] font-mono text-txt-muted uppercase">
              {pipeline}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={resetSession}
            className="rounded-lg px-2 py-1 text-[11px] text-txt-muted hover:text-txt-primary hover:bg-app-elevated/60 transition-colors"
            title="Verlauf löschen"
          >
            Neu
          </button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0 flex-col px-4 py-2">
        <div ref={chatBodyRef} role="log" aria-live="polite" aria-label="Chatverlauf" className="flex-1 min-h-0 space-y-4 overflow-y-auto pr-1 scroll-smooth">
          {messages.length === 0 && !isStreaming && (
            <div className="flex flex-col items-center justify-center h-full gap-5 py-8">
              <div className="flex flex-col items-center gap-1.5">
                <SparklesIcon className="h-8 w-8 text-accent/60" />
                <p className="text-sm font-medium text-txt-secondary">Was möchtest du verbessern?</p>
                <p className="text-[11px] text-txt-muted">Wähle eine Aktion oder schreib eine Nachricht.</p>
              </div>
              <div className="grid grid-cols-2 gap-2 w-full max-w-[420px]">
                {QUICK_PROMPTS.map((qp) => (
                  <button
                    key={qp.scope}
                    type="button"
                    onClick={() => void handleSend(qp.message, qp.scope)}
                    className="flex items-center gap-2 rounded-xl border border-app-border/60 bg-app-elevated/40 px-3 py-2.5 text-left text-xs text-txt-secondary hover:bg-app-elevated/80 hover:border-accent/40 hover:text-txt-primary transition-all"
                  >
                    <span className="text-base leading-none">{qp.icon}</span>
                    <span className="font-medium">{qp.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              role={msg.role}
              text={msg.text}
              timestamp={msg.timestamp}
              attachments={msg.attachments}
              datasheetChanges={msg.datasheetChanges}
              onApplyDatasheetChange={msg.datasheetChanges?.length ? handleApplyChange : undefined}
              applyingChangeIds={applyingChangeIds}
            />
          ))}
          {isStreaming && (
            <div className="flex justify-start" role="status" aria-live="polite">
              <div className="rounded-xl bg-app-elevated/60 border border-app-border/30 px-3 py-2 text-xs text-txt-secondary space-y-1.5 min-w-[180px] max-w-full">
                {streamEvents.length === 0 ? (
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                    <span className="text-txt-muted">{t('chat.ui.thinking')}</span>
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    {streamEvents.slice(-4).map((event, idx) => (
                      <StreamProgressLine key={idx} event={event} />
                    ))}
                  </div>
                )}

                {thoughts && (
                  <details className="rounded-lg bg-app-elevated/40 border border-app-border/40 px-3 py-2 text-[11px]">
                    <summary className="cursor-pointer text-txt-muted select-none">
                      💭 Überlegung…
                    </summary>
                    <div className="mt-2 whitespace-pre-wrap text-txt-secondary">
                      {thoughts}
                    </div>
                  </details>
                )}

                {groundingUrls.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {groundingUrls.slice(0, 6).map((chunk, idx) => {
                      let label = chunk.title || chunk.uri;
                      if (!chunk.title) {
                        try {
                          label = new URL(chunk.uri).hostname;
                        } catch {
                          label = chunk.uri;
                        }
                      }
                      return (
                        <a
                          key={`${chunk.uri}-${idx}`}
                          href={chunk.uri}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-full bg-app-elevated/50 border border-app-border/30 px-2 py-0.5 text-[10px] text-txt-muted hover:text-accent hover:border-accent/40"
                        >
                          🔗 {label}
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {(needsHuman || streamResult?.needsHumanReview) && (
            <div className="rounded-lg bg-warning-dim border border-warning/30 px-3 py-2 text-xs">
              <p className="font-semibold text-warning">⚠️ Niedrige Konfidenz — manuelle Prüfung empfohlen</p>
              {(needsHuman?.reason || streamResult?.needsHumanReview) && (
                <p className="mt-1 text-txt-secondary">
                  {needsHuman?.reason
                    || (streamResult?.lowConfidenceFields?.length
                      ? `Folgende Felder benötigen Review: ${streamResult.lowConfidenceFields.join(', ')}`
                      : 'Die Antwort enthält unsichere Angaben — bitte manuell prüfen.')}
                </p>
              )}
              {needsHuman?.suggestions?.length ? (
                <ul className="mt-1 ml-4 list-disc text-txt-muted">
                  {needsHuman.suggestions.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
        </div>

        {(pendingChanges.length > 0 || pendingImages.length > 0 || serpInsights.length > 0 || evidence.length > 0) && (
          <div className="space-y-2 border-t border-app-border/40 pt-2 text-xs text-txt-secondary shrink-0">
            {pendingChanges.length > 0 && (
              <details className="rounded-xl border border-app-border bg-app-bg/60">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-txt-secondary">
                  <span>{t('chat.ui.pendingChanges')}</span>
                  <span>{pendingChanges.length}</span>
                </summary>
                <div className="space-y-2 p-3">
                  {pendingChanges.map((item) => (
                    <div key={item.id} className="rounded-xl border border-app-border bg-app-bg/70 p-3">
                      <p className="text-sm font-semibold text-txt-primary">
                        {item.change.summary || t('chat.ui.changeFallback')}
                      </p>
                      <button
                        type="button"
                        onClick={() => handleApplyChange(item.id, item.change)}
                        disabled={applyingChangeIds.has(item.id)}
                        className="mt-2 rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-txt-primary hover:bg-accent/80 disabled:cursor-wait disabled:opacity-60"
                      >
                        {applyingChangeIds.has(item.id) ? 'Übernehme…' : t('chat.ui.apply')}
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {pendingImages.length > 0 && (
              <details className="rounded-xl border border-app-border bg-app-bg/60">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-txt-secondary">
                  <span>{t('chat.ui.imageSuggestions')}</span>
                  <span>{pendingImages.length}</span>
                </summary>
                <div className="space-y-2 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-txt-muted">
                      Tipp: Du kannst alle Vorschläge mit einem Klick übernehmen.
                    </p>
                    <button
                      type="button"
                      aria-label="Alle Bildvorschläge hinzufügen"
                      onClick={handleApplyAllImages}
                      className="rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-txt-primary hover:bg-accent/80"
                    >
                      Alle hinzufügen
                    </button>
                  </div>
                  <div className="flex gap-3 overflow-x-auto">
                  {pendingImages.map((item) => (
                    <div
                      key={item.id}
                      className="flex min-w-[160px] max-w-[160px] flex-col gap-2 rounded-xl border border-app-border bg-app-bg/70 p-2"
                    >
                      <img
                        src={resolveImageSrc(item.image.url_or_base64)}
                        alt={item.image.variant || t('chat.ui.imageAlt')}
                        className="h-24 w-full rounded-lg object-cover"
                        loading="lazy"
                        decoding="async"
                        onError={(event) => {
                          (event.currentTarget as HTMLImageElement).src = `https://placehold.co/200x200?text=${encodeURIComponent(
                            t('chat.ui.imagePlaceholder')
                          )}`;
                        }}
                      />
                      {item.rationale && <p className="text-[11px] text-txt-muted line-clamp-2">{item.rationale}</p>}
                      <button
                        type="button"
                        onClick={() => handleApplyImage(item.id)}
                        className="rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-txt-primary hover:bg-accent/80"
                      >
                        {t('chat.ui.addImage')}
                      </button>
                    </div>
                  ))}
                  </div>
                </div>
              </details>
            )}

            {evidence.length > 0 && (
              <details className="rounded-xl border border-app-border bg-app-bg/60">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-txt-secondary">
                  <span>Quellen</span>
                  <span>{evidence.length}</span>
                </summary>
                <div className="space-y-1.5 p-3 text-[11px]">
                  {evidence.slice(0, 10).map((e, idx) => (
                    <div key={`${e.url}-${idx}`} className="rounded-lg border border-app-border bg-app-bg/70 p-2">
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent hover:underline"
                      >
                        {e.title || e.url}
                      </a>
                      {e.source && <span className="ml-2 text-txt-muted">({e.source})</span>}
                      {e.snippet && <p className="mt-1 text-txt-secondary">{e.snippet}</p>}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {serpInsights.length > 0 && (
              <details className="rounded-xl border border-app-border bg-app-bg/60">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-txt-secondary">
                  <span>{t('chat.ui.serpInsights')}</span>
                  <span>{serpInsights.length}</span>
                </summary>
                <div className="space-y-2 p-3 text-[11px] text-txt-secondary">
                  {serpInsights.map((entry, index) => (
                    <div key={`${entry.engine}-${index}`} className="rounded-xl border border-app-border bg-app-bg/70 p-3">
                      <div className="flex items-center justify-between text-txt-primary">
                        <span className="font-semibold">{entry.engine}</span>
                        <span className="text-txt-muted">{entry.query}</span>
                      </div>
                      {entry.error && <p className="mt-1 text-danger">{entry.error}</p>}
                      {!entry.error &&
                        entry.summary?.slice(0, 2).map((item, idx) => (
                          <div key={idx} className="mt-1">
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-accent underline hover:text-accent"
                            >
                              {item.title || item.url}
                            </a>
                            {item.price && <span className="ml-1 text-txt-secondary">{String(item.price)}</span>}
                            {item.source && <span className="ml-1 text-txt-muted">({item.source})</span>}
                          </div>
                        ))}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      <div className="border-t border-app-border/60 px-4 py-3 shrink-0">
        {messages.length > 0 && !isStreaming && (
          <div className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-none">
            {QUICK_PROMPTS.map((qp) => (
              <button
                key={qp.scope}
                type="button"
                onClick={() => void handleSend(qp.message, qp.scope)}
                className="flex items-center gap-1 whitespace-nowrap rounded-lg border border-app-border/40 bg-app-elevated/30 px-2 py-1 text-[11px] text-txt-muted hover:text-txt-primary hover:border-accent/40 hover:bg-app-elevated/60 transition-all"
              >
                <span>{qp.icon}</span>
                <span>{qp.label}</span>
              </button>
            ))}
          </div>
        )}
        <ChatInput
          value={input}
          onChange={(v) => {
            setInput(v);
          }}
          onSend={() => void handleSend()}
          disabled={isStreaming}
          attachments={attachmentDrafts}
          onFilesSelected={handleFilesAdded}
          onRemoveAttachment={handleRemoveAttachment}
          onClearChat={resetSession}
          onInsertContext={handleInsertContext}
          charLimit={2000}
        />
      </div>
    </ChatContainer>
  );
};

export default AssistantChat;
