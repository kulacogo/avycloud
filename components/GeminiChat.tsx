
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Product, DatasheetChange, ProductImage, SerpInsight } from '../types';
import { chatWithAssistant, buildImageProxyUrl } from '../api/client';
import ChatContainer from './chat/ChatContainer';
import ChatInput, { ChatInputAttachment } from './chat/ChatInput';
import MessageBubble from './chat/MessageBubble';
import { SparklesIcon } from './icons/Icons';
import { Spinner } from './Spinner';

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

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  attachments?: MessageAttachment[];
};

type AttachmentDraft = ChatInputAttachment & { file: File };

type PendingChange = {
  id: string;
  change: DatasheetChange;
};

type PendingImage = {
  id: string;
  image: ProductImage;
  rationale?: string;
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

const mapSuggestionsToAttachments = (groups?: { rationale?: string; images: ProductImage[] }[]): MessageAttachment[] => {
  if (!groups?.length) return [];
  const attachments: MessageAttachment[] = [];
  for (const group of groups) {
    for (const image of group.images) {
      if (!image?.url_or_base64 || attachments.length >= 4) break;
      attachments.push({
        id: uid(),
        name: group.rationale || image.variant || 'Bild',
        url: image.url_or_base64,
        type: 'image/web',
        isImage: true,
      });
    }
  }
  return attachments;
};

const AssistantChat: React.FC<AssistantChatProps> = ({ product, onApplyDatasheetChange, onAddImages }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [attachmentDrafts, setAttachmentDrafts] = useState<AttachmentDraft[]>([]);
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [serpInsights, setSerpInsights] = useState<SerpInsight[]>([]);
  const [showPromptTray, setShowPromptTray] = useState(false);
  const [stickToBottom, setStickToBottom] = useState(true);

  const chatBodyRef = useRef<HTMLDivElement>(null);
  const suggestionKeysRef = useRef<Set<string>>(new Set());
  const objectUrlStore = useRef<string[]>([]);

  const quickPrompts = [
    'Item Specifics vervollständigen',
    'Titel im eBay-Stil optimieren',
    'Bullet-Features kürzen',
    'Kurzbeschreibung (2 Sätze, DE)',
    'Fehlende Identifiers prüfen',
  ];

  const quickActions = [
    { label: 'Preis prüfen', value: 'Finde günstigsten Preis neu' },
    { label: 'Marketing-Bilder', value: 'Suche Marketing-Bilder' },
    { label: 'Highlights kürzen', value: 'Fasse Highlights kürzer zusammen' },
  ];

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
        flattened.push({ id: uid(), image: img, rationale: group.rationale });
      });
    });
    if (flattened.length) {
      suggestionKeysRef.current = dedupe;
      setPendingImages((prev) => [...prev, ...flattened]);
    }
  };

  const handleApplyChange = (id: string) => {
    const match = pendingChanges.find((item) => item.id === id);
    if (!match) return;
    onApplyDatasheetChange?.(match.change);
    setPendingChanges((prev) => prev.filter((item) => item.id !== id));
  };

  const handleApplyImage = (id: string) => {
    const match = pendingImages.find((item) => item.id === id);
    if (!match) return;
    onAddImages?.([match.image]);
    setPendingImages((prev) => prev.filter((item) => item.id !== id));
  };

  const handleSend = useCallback(
    async (predefinedMessage?: string) => {
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
          text: trimmedInput || '(Dateianhang)',
          timestamp,
          attachments: userAttachments,
        },
      ]);
      setInput('');
      setAttachmentDrafts([]);
      setIsLoading(true);

      const payloadMessage = trimmedInput || 'Bitte analysiere die angehängten Dateien.';

      try {
        const result = await chatWithAssistant(product.id, payloadMessage, outgoingFiles);
        if (!result.ok || !result.data) {
          throw new Error(result.error?.message || 'Unbekannter Fehler');
        }

        const assistantAttachments = mapSuggestionsToAttachments(result.data.imageSuggestions);
        const assistantMessage: ChatMessage = {
          id: uid(),
          role: 'assistant',
          text: result.data.message,
          timestamp: new Date().toISOString(),
          attachments: assistantAttachments,
        };
        setMessages((prev) => [...prev, assistantMessage]);

        appendPendingChanges(result.data.datasheetChanges);
        appendPendingImages(result.data.imageSuggestions);
        setSerpInsights(result.data.serpTrace || []);
      } catch (error: any) {
        setMessages((prev) => [
          ...prev,
          {
            id: uid(),
            role: 'assistant',
            text: `Fehler: ${error?.message || 'Anfrage fehlgeschlagen'}`,
            timestamp: new Date().toISOString(),
          },
        ]);
        setAttachmentDrafts(outgoingDrafts);
      } finally {
        setIsLoading(false);
      }
    },
    [attachmentDrafts, input, isLoading, product.id]
  );

  return (
    <ChatContainer onFilesDropped={handleFilesAdded}>
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3 text-xs uppercase tracking-wide text-slate-400">
        <div className="flex items-center gap-2 text-slate-100">
          <SparklesIcon className="h-4 w-4 text-sky-400" />
          <span className="font-semibold text-sm text-white">GPT Assistant</span>
          <span className="text-[11px] text-slate-500">Vision · SerpAPI</span>
        </div>
        <button
          type="button"
          onClick={() => setShowPromptTray((prev) => !prev)}
          className="rounded-full border border-slate-700 px-3 py-1 text-[11px] text-slate-200 hover:border-sky-500 hover:text-white"
        >
          {showPromptTray ? 'Prompts ausblenden' : 'Prompts anzeigen'}
        </button>
      </header>

      <div className="flex-1 min-h-0 px-4 py-3">
        <div className="flex h-full flex-col gap-3">
          <div ref={chatBodyRef} className="flex-1 space-y-3 overflow-y-auto pr-1">
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                role={msg.role}
                text={msg.text}
                timestamp={msg.timestamp}
                attachments={msg.attachments}
              />
            ))}
            {isLoading && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl bg-slate-800/80 px-4 py-3 text-sm text-slate-200">
                  <Spinner className="h-4 w-4" />
                  Denke nach …
                </div>
              </div>
            )}
          </div>

          {(pendingChanges.length > 0 || pendingImages.length > 0 || serpInsights.length > 0) && (
            <div className="space-y-4 border-t border-slate-800 pt-3 text-xs text-slate-200">
              {pendingChanges.length > 0 && (
                <section>
                  <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-400">
                    <span>Vorgeschlagene Änderungen</span>
                    <span>{pendingChanges.length}</span>
                  </div>
                  <ul className="space-y-2">
                    {pendingChanges.map((item) => (
                      <li key={item.id} className="rounded-xl border border-slate-700/70 bg-slate-900/70 p-3">
                        <p className="text-sm font-semibold text-white">{item.change.summary || 'Änderung aus dem Chat'}</p>
                        <button
                          type="button"
                          onClick={() => handleApplyChange(item.id)}
                          className="mt-2 rounded-full bg-sky-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-sky-500"
                        >
                          Anwenden
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {pendingImages.length > 0 && (
                <section>
                  <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-400">
                    <span>Bild-Vorschläge</span>
                    <span>{pendingImages.length}</span>
                  </div>
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {pendingImages.map((item) => (
                      <div
                        key={item.id}
                        className="flex min-w-[160px] max-w-[160px] flex-col gap-2 rounded-xl border border-slate-700/60 bg-slate-900/70 p-2"
                      >
                        <img
                          src={resolveImageSrc(item.image.url_or_base64)}
                          alt={item.image.variant || 'Vorschlag'}
                          className="h-24 w-full rounded-lg object-cover"
                          loading="lazy"
                          decoding="async"
                          onError={(event) => {
                            (event.currentTarget as HTMLImageElement).src = 'https://placehold.co/200x200?text=Bild';
                          }}
                        />
                        {item.rationale && <p className="text-[11px] text-slate-400 line-clamp-2">{item.rationale}</p>}
                        <button
                          type="button"
                          onClick={() => handleApplyImage(item.id)}
                          className="rounded-full bg-sky-600 px-3 py-1 text-[11px] font-semibold text-white hover:bg-sky-500"
                        >
                          Hinzufügen
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {serpInsights.length > 0 && (
                <section>
                  <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-400">
                    <span>SerpAPI Nachweise</span>
                    <span>{serpInsights.length}</span>
                  </div>
                  <ul className="space-y-2 text-[11px] text-slate-200">
                    {serpInsights.map((entry, index) => (
                      <li key={`${entry.engine}-${index}`} className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3">
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
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-3 border-t border-slate-800 px-4 py-4">
        {showPromptTray && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Quick Prompts</span>
              <span>Zum Einfügen tippen</span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setInput(prompt)}
                  className="rounded-full bg-slate-800 px-3 py-1 text-[12px] text-slate-200 hover:bg-slate-700"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 overflow-x-auto pb-1 text-[12px]">
          {quickActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => handleSend(action.value)}
              className="rounded-full border border-slate-700 px-3 py-1 text-slate-200 hover:border-sky-500 hover:text-white"
            >
              {action.label}
            </button>
          ))}
        </div>

        <ChatInput
          value={input}
          onChange={setInput}
          onSend={() => handleSend()}
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
