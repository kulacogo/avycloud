
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Product, DatasheetChange, ProductImage, SerpInsight } from '../types';
import { chatWithAssistant, buildImageProxyUrl } from '../api/client';
import ChatContainer from './chat/ChatContainer';
import ChatInput, { ChatInputAttachment } from './chat/ChatInput';
import MessageBubble from './chat/MessageBubble';
import { SparklesIcon } from './icons/Icons';
import { Spinner } from './Spinner';
import { useI18n } from '../i18n';
import { normalizeBarcode, isValidGtin } from '../utils/gtin';

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
      'manufacturer_name',
      'manufacturer_address',
      'manufacturer_city',
      'manufacturer_postalcode',
      'manufacturer_state_province',
      'email',
      'manufacturer_phone',
      'url',
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
      result.attributes = entry.attributes.reduce((acc: Record<string, string | number | boolean>, item: any) => {
        if (item && typeof item.name === 'string') {
          acc[item.name] = item.value;
        }
        return acc;
      }, {});
    } else if (typeof entry.attributes === 'object') {
      result.attributes = entry.attributes;
    }
  }
  if (entry.pricing && typeof entry.pricing === 'object') {
    result.pricing = entry.pricing;
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
  const withoutCode = raw.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1');
  const withoutHtml = withoutCode.replace(/<\/?[^>]+>/g, ' ');
  return withoutHtml.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
};

const mapSuggestionsToAttachments = (
  groups: { rationale?: string; images: ProductImage[] }[] | undefined,
  fallbackLabel: string
): MessageAttachment[] => {
  if (!groups?.length) return [];
  const attachments: MessageAttachment[] = [];
  for (const group of groups) {
    for (const image of group.images) {
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

const AssistantChat: React.FC<AssistantChatProps> = ({ product, onApplyDatasheetChange, onAddImages }) => {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeScope, setActiveScope] = useState<string | null>(null);
  const [attachmentDrafts, setAttachmentDrafts] = useState<AttachmentDraft[]>([]);
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [serpInsights, setSerpInsights] = useState<SerpInsight[]>([]);
  const [showPromptTray, setShowPromptTray] = useState(false);
  const [stickToBottom, setStickToBottom] = useState(true);
  const [applyingChangeIds, setApplyingChangeIds] = useState<Set<string>>(new Set());

  const chatBodyRef = useRef<HTMLDivElement>(null);
  const suggestionKeysRef = useRef<Set<string>>(new Set());
  const objectUrlStore = useRef<string[]>([]);

  const promptTemplates: PromptTemplate[] = useMemo(
    () => [
      {
        key: 'pricing',
        label: t('chat.prompts.pricing'),
        value: 'Preis korrigieren (auf Korrektur und Plausibilität prüfen und entsprechend füllen, Duplikate vermeiden)',
      },
      {
        key: 'title',
        label: t('chat.prompts.title'),
        value:
          'Titel verbessern (TECHNISCH & suchbar, keine Marketingfloskeln/Adjektive, keine Dubletten, max. 80 Zeichen, inkl. wichtiger technischer Daten wie Modell/Herstellernummer/Größe/Spannung/Leistung/Volumen – wenn vorhanden).',
      },
      {
        key: 'attributes',
        label: t('chat.prompts.attributes'),
        value:
          'Attribute korrigieren/ergänzen (auf Korrektur und Plausibilität prüfen und entsprechend füllen, Duplikate vermeiden)',
      },
      {
        key: 'gtin',
        label: t('chat.prompts.gtin'),
        value:
          'Ermittele den zuverlässigsten Barcode (EAN = 13 Stellen, GTIN = 14 Stellen, jeweils mit gültiger Prüfziffer). Antworte ausschließlich mit JSON im DatasheetChange-Schema, z. B.: ```json\n{"identity":{"ean":"1234567890123","gtin":null}}\n``` Verwende nur Codes mit korrekter Prüfziffer. Wenn kein valider Code gefunden wird, gib {"identity":{}} zurück und nichts weiter.',
      },
      {
        key: 'datasheet',
        label: t('chat.prompts.datasheet'),
        value:
          'Datenblatt komplett verbessern: Titel (TECHNISCH, max. 80 Zeichen, inkl. Modell/Herstellernummer/Größe/Spannung/Leistung/Volumen wenn vorhanden; keine Marketingfloskeln), Beschreibung, Highlights/Attribute, Preis, Identifikatoren und Bilder prüfen, korrigieren und auffüllen (keine Duplikate). Setze exakt EINE Kategorie („Kategorie“) anhand der Liste in backend/ebay-data/categories.json und fülle alle Pflicht-Attribute für diese Kategorie anhand backend/ebay-data/required-aspects.json vollständig aus. Ergebnis e-commerce-ready und stilistisch konsistent liefern.',
      },
      {
        key: 'webImages',
        label: t('chat.prompts.webImages'),
        value:
          'Finde 3–6 Referenzbilder/Produktbilder im Internet (NUR Web-Quellen, KEINE AI-Generierung). Antworte mit konkreten URLs und liefere sie als Bild-Vorschläge, damit ich sie direkt übernehmen kann.',
      },
      {
        key: 'highlights',
        label: t('chat.prompts.highlights'),
        value:
          'Highlights verbessern (6–8 kurze Bullets, technisch/faktenbasiert, keine Dubletten, keine Verpackungstexte).',
      },
      {
        key: 'description',
        label: t('chat.prompts.description'),
        value:
          'Beschreibung korrigieren/ergänzen (auf Korrektur und Plausibilität prüfen und entsprechend füllen, Duplikate vermeiden)',
      },
    ],
    [t]
  );

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
      const key = normalizeImageKey(img?.url_or_base64);
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
  }, [messages, pendingChanges, pendingImages, serpInsights, stickToBottom]);

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
    setAttachmentDrafts([]);
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

  const appendPendingImages = (suggestions: { rationale?: string; images: ProductImage[] }[] = []) => {
    if (!suggestions.length) return;
    const dedupe = new Set(suggestionKeysRef.current);
    const flattened: PendingImage[] = [];
    suggestions.forEach((group) => {
      group.images.forEach((img) => {
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
      if (isLoading) return;
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
      setIsLoading(true);

      const payloadMessage = trimmedInput || 'Bitte analysiere die angehängten Dateien.';

      try {
        const scope = scopeOverride ?? activeScope;
        const result = await chatWithAssistant(product.id, payloadMessage, outgoingFiles, scope);
        if (!result.ok || !result.data) {
          throw new Error(result.error?.message || 'Unbekannter Fehler');
        }

        const assistantAttachments = mapSuggestionsToAttachments(result.data.imageSuggestions, t('chat.ui.imageAlt'));
        const linkedChanges = appendPendingChanges(result.data.datasheetChanges);
        const structuredEdits = extractStructuredEdits(result.data.message);
        const structuredLinked = appendPendingChanges(structuredEdits);
        const cleanedMessage = cleanAssistantMessage(result.data.message);
        const assistantMessage: ChatMessage = {
          id: uid(),
          role: 'assistant',
          text: cleanedMessage || t('chat.ui.newSuggestions'),
          timestamp: new Date().toISOString(),
          attachments: assistantAttachments,
          datasheetChanges: [...linkedChanges, ...structuredLinked],
        };
        setMessages((prev) => [...prev, assistantMessage]);

        appendPendingImages(result.data.imageSuggestions);
        setSerpInsights(result.data.serpTrace || []);
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
      } finally {
        setIsLoading(false);
      }
    },
    [activeScope, attachmentDrafts, input, isLoading, product.id, t]
  );

  return (
    <ChatContainer onFilesDropped={handleFilesAdded}>
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-xs uppercase tracking-wide text-slate-400">
        <div className="flex items-center gap-2 text-slate-100">
          <SparklesIcon className="h-4 w-4 text-sky-400" />
          <span className="font-semibold text-sm text-white">{t('chat.header.title')}</span>
          <span className="text-[11px] text-slate-500">{t('chat.header.subtitle')}</span>
        </div>
        <button
          type="button"
          onClick={() => setShowPromptTray((prev) => !prev)}
          className="rounded-full border border-slate-700 px-3 py-1 text-[11px] text-slate-200 hover:border-sky-500 hover:text-white"
        >
          {showPromptTray ? t('chat.ui.promptsHide') : t('chat.ui.promptsShow')}
        </button>
      </header>

      <div className="flex flex-1 min-h-0 flex-col gap-3 px-4 py-3">
        <div ref={chatBodyRef} className="flex-1 min-h-0 space-y-3 overflow-y-auto pr-1">
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
          {isLoading && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl bg-slate-800/80 px-4 py-3 text-sm text-slate-200">
                <Spinner className="h-4 w-4" />
                {t('chat.ui.thinking')}
              </div>
            </div>
          )}
        </div>

        {(pendingChanges.length > 0 || pendingImages.length > 0 || serpInsights.length > 0) && (
          <div className="space-y-4 border-t border-slate-800 pt-3 text-xs text-slate-200">
            {pendingChanges.length > 0 && (
              <details className="rounded-xl border border-slate-700/60 bg-slate-900/60">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-200">
                  <span>{t('chat.ui.pendingChanges')}</span>
                  <span>{pendingChanges.length}</span>
                </summary>
                <div className="space-y-2 p-3">
                  {pendingChanges.map((item) => (
                    <div key={item.id} className="rounded-xl border border-slate-700/70 bg-slate-900/70 p-3">
                      <p className="text-sm font-semibold text-white">
                        {item.change.summary || t('chat.ui.changeFallback')}
                      </p>
                      <button
                        type="button"
                        onClick={() => handleApplyChange(item.id, item.change)}
                        disabled={applyingChangeIds.has(item.id)}
                        className="mt-2 rounded-full bg-sky-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-sky-500 disabled:cursor-wait disabled:opacity-60"
                      >
                        {applyingChangeIds.has(item.id) ? 'Übernehme…' : t('chat.ui.apply')}
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {pendingImages.length > 0 && (
              <details className="rounded-xl border border-slate-700/60 bg-slate-900/60">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-200">
                  <span>{t('chat.ui.imageSuggestions')}</span>
                  <span>{pendingImages.length}</span>
                </summary>
                <div className="space-y-2 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-slate-400">
                      Tipp: Du kannst alle Vorschläge mit einem Klick übernehmen.
                    </p>
                    <button
                      type="button"
                      onClick={handleApplyAllImages}
                      className="rounded-full bg-sky-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-sky-500"
                    >
                      Alle hinzufügen
                    </button>
                  </div>
                  <div className="flex gap-3 overflow-x-auto">
                  {pendingImages.map((item) => (
                    <div
                      key={item.id}
                      className="flex min-w-[160px] max-w-[160px] flex-col gap-2 rounded-xl border border-slate-700/60 bg-slate-900/70 p-2"
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
                      {item.rationale && <p className="text-[11px] text-slate-400 line-clamp-2">{item.rationale}</p>}
                      <button
                        type="button"
                        onClick={() => handleApplyImage(item.id)}
                        className="rounded-full bg-sky-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-sky-500"
                      >
                        {t('chat.ui.addImage')}
                      </button>
                    </div>
                  ))}
                  </div>
                </div>
              </details>
            )}

            {serpInsights.length > 0 && (
              <details className="rounded-xl border border-slate-700/60 bg-slate-900/60">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-200">
                  <span>{t('chat.ui.serpInsights')}</span>
                  <span>{serpInsights.length}</span>
                </summary>
                <div className="space-y-2 p-3 text-[11px] text-slate-200">
                  {serpInsights.map((entry, index) => (
                    <div key={`${entry.engine}-${index}`} className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3">
                      <div className="flex items-center justify-between text-slate-100">
                        <span className="font-semibold">{entry.engine}</span>
                        <span className="text-slate-400">{entry.query}</span>
                      </div>
                      {entry.error && <p className="mt-1 text-red-400">{entry.error}</p>}
                      {!entry.error &&
                        entry.summary?.slice(0, 2).map((item, idx) => (
                          <div key={idx} className="mt-1">
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-sky-400 underline hover:text-sky-200"
                            >
                              {item.title || item.url}
                            </a>
                            {item.price && <span className="ml-1 text-slate-300">{String(item.price)}</span>}
                            {item.source && <span className="ml-1 text-slate-400">({item.source})</span>}
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

      <div className="space-y-3 border-t border-slate-800 px-4 py-4">
        {showPromptTray && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>{t('chat.ui.quickTitle')}</span>
              <span>{t('chat.ui.quickHint')}</span>
            </div>
            <div className="flex flex-wrap gap-2 pb-1">
              {promptTemplates.map((prompt) => (
                <button
                  key={`tray-${prompt.key}`}
                  type="button"
                  onClick={() => {
                    setInput(prompt.value);
                    setActiveScope(prompt.key);
                  }}
                  className="rounded-full bg-slate-800 px-3 py-1 text-[12px] text-slate-200 hover:bg-slate-700"
                >
                  {prompt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pb-1 text-[12px]">
          {promptTemplates.map((action) => (
            <button
              key={`action-${action.key}`}
              type="button"
              onClick={() => {
                setActiveScope(action.key);
                void handleSend(action.value, action.key);
              }}
              className="rounded-full border border-slate-700 px-3 py-1 text-slate-200 hover:border-sky-500 hover:text-white"
            >
              {action.label}
            </button>
          ))}
        </div>

        <ChatInput
          value={input}
          onChange={(v) => {
            setInput(v);
            // Free typing should not keep a stale scope implicitly.
            setActiveScope(null);
          }}
          onSend={() => void handleSend()}
          disabled={isLoading}
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
