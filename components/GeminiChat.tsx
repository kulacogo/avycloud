
import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Product, DatasheetChange, ProductImage, SerpInsight } from '../types';
import { chatWithAssistant, buildImageProxyUrl } from '../api/client';
import { SendIcon, SparklesIcon } from './icons/Icons';
import { Spinner } from './Spinner';

interface AssistantChatProps {
  product: Product;
  onApplyDatasheetChange?: (change: DatasheetChange) => void;
  onAddImages?: (images: ProductImage[]) => void;
}

type Message = {
  role: 'user' | 'assistant';
  text: string;
};

type PendingChange = {
  id: string;
  change: DatasheetChange;
};

type PendingImage = {
  id: string;
  image: ProductImage;
  rationale?: string;
};

const uid = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

const AssistantChat: React.FC<AssistantChatProps> = ({ product, onApplyDatasheetChange, onAddImages }) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [serpInsights, setSerpInsights] = useState<SerpInsight[]>([]);
  const [showPromptTray, setShowPromptTray] = useState(false);
  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const suggestionKeysRef = useRef<Set<string>>(new Set());
  const quickPrompts = [
    'Item Specifics vervollständigen',
    'Titel im eBay-Stil optimieren',
    'Bullet-Features kürzen',
    'Kurzbeschreibung (2 Sätze, DE)',
    'Fehlende Identifiers prüfen',
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

  const renderContent = (text: string) => {
    const trimmed = text.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const obj = JSON.parse(trimmed);
        return (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">
            {JSON.stringify(obj, null, 2)}
          </pre>
        );
      } catch {
        // fall through
      }
    }
    const parts = text.split(/(https?:\/\/\S+)/g);
    return parts.map((part, idx) => {
      if (/^https?:\/\//.test(part)) {
        return (
          <a key={idx} href={part} target="_blank" rel="noreferrer" className="underline text-sky-400 break-all">
            {part}
          </a>
        );
      }
      return <span key={idx}>{part}</span>;
    });
  };

  const resolveImageSrc = (value: string) => {
    if (!value) return '';
    return buildImageProxyUrl(value);
  };

  useEffect(() => {
    if (bottomAnchorRef.current) {
      bottomAnchorRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'end',
      });
    }
  }, [messages, pendingChanges, pendingImages, serpInsights]);

  const handleSend = async (predefinedMessage?: string) => {
    const messageText = predefinedMessage || input;
    if (!messageText.trim()) return;

    const userMessage: Message = { role: 'user', text: messageText };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    const result = await chatWithAssistant(product.id, messageText);

    if (result.ok && result.data) {
      const modelMessage: Message = { role: 'assistant', text: result.data.message };
      setMessages(prev => [...prev, modelMessage]);

      if (result.data.datasheetChanges?.length) {
        const mapped = result.data.datasheetChanges
          .filter(change => Object.keys(change).length > 0)
          .map(change => ({ id: uid(), change }));
        if (mapped.length) {
          setPendingChanges(prev => [...prev, ...mapped]);
        }
      }

      if (result.data.imageSuggestions?.length) {
        const dedupe = new Set(suggestionKeysRef.current);
        const flattened: PendingImage[] = [];
        result.data.imageSuggestions.forEach(group => {
          group.images.forEach(img => {
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
          setPendingImages(prev => [...prev, ...flattened]);
        }
      }

      setSerpInsights(result.data.serpTrace || []);
    } else {
      const errorMessage: Message = {
        role: 'assistant',
        text: `Fehler: ${result.error?.message || 'Unbekannter Fehler'}`,
      };
      setMessages(prev => [...prev, errorMessage]);
    }
    setIsLoading(false);
  };

  const applyChange = (id: string) => {
    const match = pendingChanges.find(item => item.id === id);
    if (!match) return;
    onApplyDatasheetChange?.(match.change);
    setPendingChanges(prev => prev.filter(item => item.id !== id));
  };

  const applyImage = (id: string) => {
    const match = pendingImages.find(item => item.id === id);
    if (!match) return;
    onAddImages?.([match.image]);
    setPendingImages(prev => prev.filter(item => item.id !== id));
  };

  const quickActions = [
    { label: 'Preis prüfen', value: 'Finde günstigsten Preis neu' },
    { label: 'Marketing-Bilder', value: 'Suche Marketing-Bilder' },
    { label: 'Highlights kürzen', value: 'Fasse Highlights kürzer zusammen' },
  ];

  const resetSession = () => {
    setMessages([]);
    setPendingChanges([]);
    setPendingImages([]);
    setSerpInsights([]);
  };

  return (
    <aside
      id="assistant-chat"
      className="flex flex-col h-full max-h-full min-h-[420px] bg-slate-900/70 border-l border-slate-800 rounded-xl"
    >
      <header className="flex items-center justify-between px-3 py-2 border-b border-slate-800 text-xs uppercase tracking-wide text-slate-400">
        <div className="flex items-center gap-2 text-slate-200">
          <SparklesIcon className="w-4 h-4 text-sky-400" />
          <span className="font-semibold text-sm text-white">GPT Assistant</span>
          <span className="text-[11px] text-slate-500">Vision · SerpAPI</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowPromptTray((prev) => !prev)}
            className="px-2 py-1 rounded-full bg-slate-800 text-slate-300 text-[11px] hover:text-white transition"
          >
            {showPromptTray ? 'Prompts ausblenden' : 'Prompts anzeigen'}
          </button>
          <button
            type="button"
            onClick={resetSession}
            className="px-2 py-1 rounded-full bg-slate-800 text-slate-300 text-[11px] hover:text-white transition"
          >
            Verlauf löschen
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 px-3 py-3">
        <div className="flex h-full flex-col gap-3">
          <div className="flex-1 overflow-y-auto space-y-4 pr-1">
            <div id="chat-log" className="space-y-3 text-sm">
            {messages.map((msg, index) => (
                <div
                  key={index}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                <div
                    className={`max-w-[82%] px-3 py-2 rounded-2xl whitespace-pre-wrap break-words ${
                      msg.role === 'user'
                        ? 'bg-sky-600/80 text-white'
                        : 'bg-slate-800/80 text-slate-200 border border-slate-800/80'
                  }`}
                >
                  {renderContent(msg.text)}
                </div>
              </div>
            ))}
            {isLoading && (
              <div className="flex justify-start">
                  <div className="max-w-[65%] px-3 py-2 rounded-2xl bg-slate-800/80 text-slate-200 flex items-center gap-2 text-sm">
                    <Spinner className="w-4 h-4" />
                    Denke nach …
                </div>
              </div>
            )}
          </div>

          {(pendingChanges.length > 0 || pendingImages.length > 0 || serpInsights.length > 0) && (
              <div className="space-y-4 border-t border-slate-800 pt-3">
              {pendingChanges.length > 0 && (
                <section>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
                        Vorgeschlagene Änderungen
                      </h4>
                      <span className="text-[11px] text-slate-500">
                        {pendingChanges.length} Vorschlag{pendingChanges.length > 1 ? 'e' : ''}
                      </span>
                    </div>
                  <ul className="space-y-2">
                      {pendingChanges.map((item) => (
                        <li key={item.id} className="p-3 bg-slate-800/70 border border-slate-800 rounded-lg text-xs text-slate-200">
                          <p className="font-semibold text-sm mb-1">{item.change.summary || 'Änderung aus dem Chat'}</p>
                        <button
                          onClick={() => applyChange(item.id)}
                            className="mt-2 px-3 py-1 text-[11px] bg-sky-600 text-white rounded-full hover:bg-sky-500"
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
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
                        Bild-Vorschläge
                      </h4>
                      <span className="text-[11px] text-slate-500">
                        {pendingImages.length} neu
                      </span>
                    </div>
                    <div className="flex gap-3 overflow-x-auto pb-1">
                      {pendingImages.map((item) => (
                        <div
                          key={item.id}
                          className="min-w-[140px] max-w-[140px] bg-slate-800/70 border border-slate-800 rounded-lg p-2 text-[11px] text-slate-200 flex flex-col gap-2"
                        >
                        <img
                          src={resolveImageSrc(item.image.url_or_base64)}
                          alt="Vorschlag"
                            className="w-full h-24 object-cover rounded"
                          referrerPolicy="no-referrer"
                          loading="lazy"
                          decoding="async"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).src = 'https://placehold.co/200x200?text=Bild';
                          }}
                        />
                    {item.image.source && (
                            <p className="text-[10px] uppercase tracking-wide text-slate-400">
                        {item.image.source}
                      </p>
                    )}
                          {item.rationale && (
                            <p className="text-[10px] text-slate-400 line-clamp-2">
                              {item.rationale}
                            </p>
                          )}
                        <button
                          onClick={() => applyImage(item.id)}
                            className="px-2 py-1 text-[11px] bg-sky-600 text-white rounded-full hover:bg-sky-500 w-full"
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
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
                        SerpAPI Nachweise
                      </h4>
                      <span className="text-[11px] text-slate-500">{serpInsights.length}</span>
                    </div>
                    <ul className="space-y-2 text-[11px] text-slate-300">
                    {serpInsights.map((entry, idx) => (
                        <li key={`${entry.engine}-${idx}`} className="p-2 bg-slate-800/70 border border-slate-800 rounded">
                          <div className="flex items-center justify-between text-slate-100 text-[12px]">
                            <p className="font-semibold">{entry.engine}</p>
                            <p className="text-slate-500">{entry.query}</p>
                          </div>
                        {entry.error && <p className="text-red-400 mt-1">{entry.error}</p>}
                        {!entry.error &&
                          entry.summary?.slice(0, 2).map((item, i) => (
                            <div key={i} className="mt-1">
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-sky-400 underline"
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

            <div ref={bottomAnchorRef} className="h-1" />
          </div>
        </div>
      </div>

      <div className="border-t border-slate-800 px-3 py-3 space-y-2">
        {showPromptTray && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Quick Prompts</span>
              <span>Tap zum Einfügen</span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
          {quickPrompts.map((prompt) => (
            <button
              key={prompt}
              onClick={() => setInput(prompt)}
                  className="px-3 py-1 rounded-full bg-slate-800 text-slate-200 text-[12px] whitespace-nowrap hover:bg-slate-700"
            >
              {prompt}
            </button>
          ))}
        </div>
          </div>
        )}

        <div className="flex gap-2 overflow-x-auto pb-1">
          {quickActions.map((action) => (
            <button
              key={action.label}
              onClick={() => handleSend(action.value)}
              className="px-3 py-1 rounded-full border border-slate-700 text-[12px] text-slate-200 hover:border-sky-500 hover:text-white whitespace-nowrap"
            >
              {action.label}
            </button>
          ))}
        </div>

        <div className="flex items-center space-x-2">
          <input
            id="chat-input"
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Frag GPT nach Preisen, Bildern oder Optimierungen..."
          className="flex-1 p-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-100 focus:ring-2 focus:ring-sky-500"
          />
          <button
            id="chat-send"
            onClick={() => handleSend()}
            disabled={isLoading}
          className="p-2 bg-sky-600 text-white rounded-lg hover:bg-sky-500 disabled:bg-slate-600"
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </aside>
  );
};

export default AssistantChat;
