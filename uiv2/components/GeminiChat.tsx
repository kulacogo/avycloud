
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
      'country_code',
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
  if (typeof entry.baselinkerCategoryPath === 'string' && entry.baselinkerCategoryPath.trim()) {
    result.baselinkerCategoryPath = entry.baselinkerCategoryPath.trim();
  }
  if (typeof entry.baselinkerCategoryId === 'string' && entry.baselinkerCategoryId.trim()) {
    result.baselinkerCategoryId = entry.baselinkerCategoryId.trim();
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
    // Research strategy
    marketplaceFirst: true,
    broadFallback: true,
    maxPagesToFetch: 2,
  }));

  const applyPromptScene = useCallback((scene: string) => {
    const base = {
      // default research behavior
      marketplaceFirst: true,
      broadFallback: true,
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

    const research = [
      promptConfig.marketplaceFirst ? 'Marketplace-first (ebay.de/kaufland.de/hood.de)' : null,
      promptConfig.broadFallback ? 'Fallback: breite Websuche (ohne site-Limit)' : null,
      `Fetch: max. ${Math.max(1, Math.min(3, Number(promptConfig.maxPagesToFetch) || 2))} Seiten lesen`,
    ]
      .filter(Boolean)
      .join(', ');

    return [
      `Ziel: ${goals.length ? goals.join(', ') : 'Datenblatt verbessern'}.`,
      `Recherche: ${research}.`,
      'Bitte arbeite evidenzbasiert: erst suchen, dann 1–2 passende Seiten laden, dann Änderungen vorschlagen.',
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
      'gpsr',
    ];
    const selected = keys.filter((k) => Boolean((promptConfig as any)[k]));
    if (selected.length !== 1) return 'datasheet';
    const only = selected[0];
    if (only === 'title') return 'title';
    if (only === 'pricing') return 'pricing';
    if (only === 'gtin') return 'gtin';
    if (only === 'description') return 'description';
    if (only === 'highlights') return 'highlights';
    if (only === 'attributes') return 'attributes';
    if (only === 'gpsr') return 'gpsr';
    return 'datasheet';
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
      <header className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3 text-xs uppercase tracking-wide text-[color:var(--text-tertiary)]">
        <div className="flex items-center gap-2 text-[color:var(--text-primary)]">
          <SparklesIcon className="h-4 w-4 text-[color:var(--avy-purple-light)]" />
          <span className="font-semibold text-sm text-[color:white]">{t('chat.header.title')}</span>
          <span className="text-[11px] text-[color:var(--text-tertiary)]">{t('chat.header.subtitle')}</span>
        </div>
        <button
          type="button"
          onClick={() => {
            setInput(buildSmartPrompt());
            setActiveScope(derivedScope);
          }}
          className="rounded-full border border-[var(--border)] px-3 py-1 text-[11px] text-[color:var(--text-primary)] hover:border-[var(--avy-purple)] hover:text-[color:var(--text-primary)]"
          title="Erzeugt einen smarten Prompt aus den Optionen."
        >
          Prompt bauen
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
              <div className="flex items-center gap-2 rounded-2xl bg-[var(--surface-hover)]/80 px-4 py-3 text-sm text-[color:var(--text-primary)]">
                <Spinner className="h-4 w-4" />
                {t('chat.ui.thinking')}
              </div>
            </div>
          )}
        </div>

        {(pendingChanges.length > 0 || pendingImages.length > 0 || serpInsights.length > 0) && (
          <div className="space-y-4 border-t border-[var(--border)] pt-3 text-xs text-[color:var(--text-primary)]">
            {pendingChanges.length > 0 && (
              <details className="rounded-xl border border-[var(--border)]/60 bg-[var(--surface-secondary)]/60">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--text-primary)]">
                  <span>{t('chat.ui.pendingChanges')}</span>
                  <span>{pendingChanges.length}</span>
                </summary>
                <div className="space-y-2 p-3">
                  {pendingChanges.map((item) => (
                    <div key={item.id} className="rounded-xl border border-[var(--border)]/70 bg-[var(--surface-secondary)]/70 p-3">
                      <p className="text-sm font-semibold text-[color:white]">
                        {item.change.summary || t('chat.ui.changeFallback')}
                      </p>
                      <button
                        type="button"
                        onClick={() => handleApplyChange(item.id, item.change)}
                        disabled={applyingChangeIds.has(item.id)}
                        className="mt-2 rounded-full bg-[var(--avy-purple)] px-3 py-1 text-[11px] font-semibold text-[color:white] hover:bg-[var(--avy-purple-hover)] disabled:cursor-wait disabled:opacity-60"
                      >
                        {applyingChangeIds.has(item.id) ? 'Übernehme…' : t('chat.ui.apply')}
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {pendingImages.length > 0 && (
              <details className="rounded-xl border border-[var(--border)]/60 bg-[var(--surface-secondary)]/60">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--text-primary)]">
                  <span>{t('chat.ui.imageSuggestions')}</span>
                  <span>{pendingImages.length}</span>
                </summary>
                <div className="space-y-2 p-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-[color:var(--text-tertiary)]">
                      Tipp: Du kannst alle Vorschläge mit einem Klick übernehmen.
                    </p>
                    <button
                      type="button"
                      onClick={handleApplyAllImages}
                      className="rounded-full bg-[var(--avy-purple)] px-3 py-1 text-[11px] font-semibold text-[color:white] hover:bg-[var(--avy-purple-hover)]"
                    >
                      Alle hinzufügen
                    </button>
                  </div>
                  <div className="flex gap-3 overflow-x-auto">
                  {pendingImages.map((item) => (
                    <div
                      key={item.id}
                      className="flex min-w-[160px] max-w-[160px] flex-col gap-2 rounded-xl border border-[var(--border)]/60 bg-[var(--surface-secondary)]/70 p-2"
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
                      {item.rationale && <p className="text-[11px] text-[color:var(--text-tertiary)] line-clamp-2">{item.rationale}</p>}
                      <button
                        type="button"
                        onClick={() => handleApplyImage(item.id)}
                        className="rounded-full bg-[var(--avy-purple)] px-3 py-1 text-[11px] font-semibold text-[color:white] hover:bg-[var(--avy-purple-hover)]"
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
              <details className="rounded-xl border border-[var(--border)]/60 bg-[var(--surface-secondary)]/60">
                <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--text-primary)]">
                  <span>{t('chat.ui.serpInsights')}</span>
                  <span>{serpInsights.length}</span>
                </summary>
                <div className="space-y-2 p-3 text-[11px] text-[color:var(--text-primary)]">
                  {serpInsights.map((entry, index) => (
                    <div key={`${entry.engine}-${index}`} className="rounded-xl border border-[var(--border)]/60 bg-[var(--surface-secondary)]/70 p-3">
                      <div className="flex items-center justify-between text-[color:var(--text-primary)]">
                        <span className="font-semibold">{entry.engine}</span>
                        <span className="text-[color:var(--text-tertiary)]">{entry.query}</span>
                      </div>
                      {entry.error && <p className="mt-1 text-[color:var(--error)]">{entry.error}</p>}
                      {!entry.error &&
                        entry.summary?.slice(0, 2).map((item, idx) => (
                          <div key={idx} className="mt-1">
                            <a
                              href={item.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[color:var(--avy-purple-light)] underline hover:text-[color:var(--avy-purple-light)]"
                            >
                              {item.title || item.url}
                            </a>
                            {item.price && <span className="ml-1 text-[color:var(--text-secondary)]">{String(item.price)}</span>}
                            {item.source && <span className="ml-1 text-[color:var(--text-tertiary)]">({item.source})</span>}
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

      <div className="space-y-3 border-t border-[var(--border)] px-4 py-4">
        <details className="rounded-2xl border border-[var(--border)] bg-[var(--bg)]/30 p-3">
          <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wide text-[color:var(--text-secondary)]">
            Assistant Optionen
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-2 text-[12px]">
                {[
                  ['full', 'Vollständig'],
                  ['title', 'Nur Titel'],
                  ['gtin', 'Nur EAN/GTIN'],
                  ['gpsr', 'Nur GPSR'],
                  ['images', 'Nur Web-Bilder'],
                  ['pricing', 'Preischeck'],
                  ['category', 'Kategorie + Pflichtattribute'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => applyPromptScene(String(key))}
                    className="rounded-full border border-[var(--border)] bg-[var(--surface-secondary)]/40 px-3 py-1 text-[color:var(--text-primary)] hover:border-[var(--avy-purple)] hover:text-[color:var(--text-primary)]"
                    title="Setzt nur die Optionen (kein starrer Prompt)."
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => {
                  const smart = buildSmartPrompt();
                  setInput(smart);
                  setActiveScope(derivedScope);
                }}
                className="rounded-full bg-[var(--surface-hover)] px-3 py-1 text-[12px] text-[color:var(--text-primary)] hover:bg-[var(--surface)]"
                title="Schreibt den smarten Prompt in die Eingabe."
              >
                Vorschau in Eingabe
              </button>
            </div>

            <div className="flex flex-wrap gap-2 text-[12px]">
              {[
                ['title', 'Titel'],
                ['attributes', 'Attribute'],
                ['highlights', 'Highlights'],
                ['description', 'Beschreibung'],
                ['pricing', 'Preis'],
                ['gtin', 'EAN/GTIN'],
                ['images', 'Web-Bilder'],
                ['gpsr', 'GPSR'],
                ['category', 'Kategorie'],
              ].map(([key, label]) => (
                <label
                  key={key}
                  className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-secondary)]/40 px-3 py-1 text-[color:var(--text-primary)] hover:border-[var(--avy-purple)]"
                >
                  <input
                    type="checkbox"
                    checked={(promptConfig as any)[key]}
                    onChange={(e) => setPromptConfig((prev) => ({ ...prev, [key]: e.target.checked } as any))}
                  />
                  {label}
                </label>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 text-[12px]">
              <label className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-secondary)]/40 px-3 py-1 text-[color:var(--text-primary)] hover:border-[var(--avy-purple)]">
                <input
                  type="checkbox"
                  checked={promptConfig.marketplaceFirst}
                  onChange={(e) => setPromptConfig((prev) => ({ ...prev, marketplaceFirst: e.target.checked }))}
                />
                Marketplace-first
              </label>
              <label className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-secondary)]/40 px-3 py-1 text-[color:var(--text-primary)] hover:border-[var(--avy-purple)]">
                <input
                  type="checkbox"
                  checked={promptConfig.broadFallback}
                  onChange={(e) => setPromptConfig((prev) => ({ ...prev, broadFallback: e.target.checked }))}
                />
                Broad-Fallback
              </label>
              <label className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface-secondary)]/40 px-3 py-1 text-[color:var(--text-primary)] hover:border-[var(--avy-purple)]">
                Fetch-Seiten
                <select
                  value={promptConfig.maxPagesToFetch}
                  onChange={(e) => setPromptConfig((prev) => ({ ...prev, maxPagesToFetch: Number(e.target.value) }))}
                  className="rounded-md bg-[var(--surface-hover)] px-2 py-1 text-[color:var(--text-primary)]"
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                </select>
              </label>
              <button
                type="button"
                onClick={() => {
                  const smart = buildSmartPrompt();
                  setActiveScope(derivedScope);
                  void handleSend(smart, derivedScope);
                }}
                className="rounded-full bg-[var(--avy-purple)] px-3 py-1 text-[12px] font-semibold text-[color:white] hover:bg-[var(--avy-purple-hover)]"
              >
                Jetzt ausführen
              </button>
            </div>
          </div>
        </details>

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
