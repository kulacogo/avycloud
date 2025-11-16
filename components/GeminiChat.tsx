
import React, { useState, useRef, useEffect } from 'react';
import { Product, DatasheetChange, ProductImage, SerpInsight } from '../types';
import { chatWithAssistant } from '../api/client';
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
  const chatLogRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (chatLogRef.current) {
      chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
    }
  }, [messages, pendingChanges, pendingImages]);

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
        const flattened: PendingImage[] = [];
        result.data.imageSuggestions.forEach(group => {
          group.images.forEach(img => flattened.push({ id: uid(), image: img, rationale: group.rationale }));
        });
        if (flattened.length) {
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

  const predefinedActions = [
    'Finde günstigsten Preis neu',
    'Suche Marketing-Bilder',
    'Fasse Highlights kürzer zusammen',
  ];

  return (
    <aside id="assistant-chat" className="flex flex-col h-[70vh] bg-slate-800 rounded-lg shadow-lg">
      <header className="flex items-center p-4 border-b border-slate-700">
        <SparklesIcon className="w-6 h-6 text-sky-400" />
        <h3 className="ml-2 text-lg font-semibold text-white">GPT-5.1 Assistant</h3>
      </header>

      <div id="chat-log" ref={chatLogRef} className="flex-1 p-4 space-y-4 overflow-y-auto">
        {messages.map((msg, index) => (
          <div key={index} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-xs lg:max-w-sm px-4 py-2 rounded-lg whitespace-pre-wrap break-words ${
                msg.role === 'user' ? 'bg-sky-600 text-white' : 'bg-slate-700 text-slate-200'
              }`}
            >
              {renderContent(msg.text)}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="max-w-xs lg:max-w-sm px-4 py-2 rounded-lg bg-slate-700 text-slate-200 flex items-center">
              <Spinner className="w-5 h-5 mr-2" /> Thinking...
            </div>
          </div>
        )}
      </div>

      {(pendingChanges.length > 0 || pendingImages.length > 0 || serpInsights.length > 0) && (
        <div className="p-4 border-t border-slate-700 space-y-4 max-h-[45vh] overflow-y-auto">
          {pendingChanges.length > 0 && (
            <section>
              <h4 className="text-sm font-semibold text-slate-200 mb-2">Vorgeschlagene Änderungen</h4>
              <ul className="space-y-2">
                {pendingChanges.map(item => (
                  <li key={item.id} className="p-3 bg-slate-700 rounded-lg text-sm text-slate-200">
                    <p className="font-semibold mb-1">{item.change.summary || 'Änderung aus dem Chat'}</p>
                    <button
                      onClick={() => applyChange(item.id)}
                      className="mt-2 px-3 py-1 text-xs bg-sky-600 text-white rounded hover:bg-sky-500"
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
              <h4 className="text-sm font-semibold text-slate-200 mb-2">Bild-Vorschläge</h4>
              <div className="grid grid-cols-2 gap-3">
                {pendingImages.map(item => (
                  <div key={item.id} className="bg-slate-700 rounded-lg p-2 text-xs text-slate-200">
                    <img
                      src={item.image.url_or_base64}
                      alt="Vorschlag"
                      className="w-full h-24 object-cover rounded mb-2"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).src = 'https://placehold.co/200x200?text=Bild';
                      }}
                    />
                    {item.rationale && <p className="mb-1 text-slate-400">{item.rationale}</p>}
                    <button
                      onClick={() => applyImage(item.id)}
                      className="px-2 py-1 text-xs bg-sky-600 text-white rounded hover:bg-sky-500 w-full"
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
              <h4 className="text-sm font-semibold text-slate-200 mb-2">SerpAPI Nachweise</h4>
              <ul className="space-y-2 text-xs text-slate-300">
                {serpInsights.map((entry, idx) => (
                  <li key={`${entry.engine}-${idx}`} className="p-2 bg-slate-700 rounded">
                    <p className="font-semibold text-slate-100">{entry.engine}</p>
                    <p className="text-slate-400 break-words">{entry.query}</p>
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

      <div className="p-4 border-t border-slate-700">
        <div className="flex flex-wrap gap-2 mb-3">
          {predefinedActions.map(action => (
            <button
              key={action}
              onClick={() => handleSend(action)}
              className="px-2 py-1 text-xs bg-slate-600/50 text-slate-300 rounded-full hover:bg-slate-600"
            >
              {action}
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
            className="flex-1 p-2 bg-slate-700 border border-slate-600 rounded-lg focus:ring-2 focus:ring-sky-500"
          />
          <button
            id="chat-send"
            onClick={() => handleSend()}
            disabled={isLoading}
            className="p-2 bg-sky-600 text-white rounded-lg hover:bg-sky-500 disabled:bg-slate-500"
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </aside>
  );
};

export default AssistantChat;
