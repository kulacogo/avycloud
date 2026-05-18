import { fetchApi, getBackendUrl } from "./client";

export interface HelpIndexEntry {
  slug: string;
  title: string;
  for: string[];
  lastReviewed: string;
  section: string;
  topic?: string;
  icon?: string;
  order?: number | null;
}

export interface HelpArticle {
  slug: string;
  title: string;
  for: string[];
  lastReviewed: string;
  content: string;
  topic?: string;
  icon?: string;
  order?: number | null;
}

export type HelpIndex = Record<string, HelpIndexEntry[]>;

const helpUrl = (path: string): string => `${getBackendUrl()}/api/help${path}`;

const parseHelpJson = async <T>(res: Response, label: string): Promise<T> => {
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  if (!res.ok) {
    const preview = text ? ` — ${text.slice(0, 180)}` : "";
    throw new Error(`Help ${label} failed (${res.status})${preview}`);
  }
  if (!text.trim()) {
    return {} as T;
  }
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(`Help ${label} returned invalid JSON`);
    }
  }
  if (contentType.includes("text/html")) {
    throw new Error(`Help ${label} returned HTML instead of JSON`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
};

export const fetchHelpIndex = async (): Promise<HelpIndex> => {
  const res = await fetchApi(helpUrl("/index"), { method: "GET" });
  const data = await parseHelpJson<any>(res, "index");
  if (data && typeof data === "object" && !Array.isArray(data)) {
    if (data.data && typeof data.data === "object") return data.data as HelpIndex;
    return data as HelpIndex;
  }
  return {} as HelpIndex;
};

export const fetchHelpArticle = async (slug: string): Promise<HelpArticle> => {
  const safeSlug = encodeURIComponent(String(slug || "").trim());
  if (!safeSlug) throw new Error("Help article slug is empty");
  const res = await fetchApi(helpUrl(`/articles/${safeSlug}`), { method: "GET" });
  const data = await parseHelpJson<any>(res, `article ${slug}`);
  if (data && typeof data === "object") {
    if (data.data && typeof data.data === "object") return data.data as HelpArticle;
    return data as HelpArticle;
  }
  throw new Error(`Help article ${slug} returned no data`);
};
