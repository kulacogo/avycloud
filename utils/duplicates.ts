import type { Product } from "../types.ts";
import { getProductAvailableQuantity, getProductPhysicalQuantity, getProductBinCode } from "./product.ts";

/**
 * Aufbereitung der Duplikat-Liste.
 *
 * Der Server liefert je Gruppe NUR Typ, Schlüssel und Produkt-IDs — sonst
 * nichts. Die Seite konnte deshalb nichts anzeigen, wonach man hätte sortieren
 * oder filtern können: man musste jeden Eintrag einzeln öffnen, um überhaupt zu
 * sehen, ob es sich lohnt.
 *
 * Die Produktdaten liegen im Browser ohnehin schon vor. Hier werden sie an die
 * Gruppen gehängt und zu genau den Angaben verdichtet, nach denen man
 * priorisiert: Bestand, Online-Status, Wert.
 */

export interface DuplicateGroupInput {
  type: string;
  key: string;
  productIds: string[];
}

export interface DuplicateMember {
  id: string;
  name: string;
  sku: string;
  ean: string;
  imageUrl: string | null;
  available: number;
  physical: number;
  binCode: string | null;
  price: number | null;
  listedEbay: boolean;
  listedKaufland: boolean;
  createdAt: string | null;
  /** Produkt existiert nicht (mehr) in der geladenen Liste. */
  missing: boolean;
}

export interface EnrichedDuplicateGroup {
  type: string;
  key: string;
  members: DuplicateMember[];
  /** Summe des physischen Bestands aller Mitglieder. */
  totalStock: number;
  /** Anzahl Mitglieder mit Bestand > 0. */
  membersWithStock: number;
  /** Mindestens zwei Mitglieder sind online — echtes Doppelangebot. */
  multipleListed: boolean;
  anyListed: boolean;
  /** Höchster Verkaufspreis in der Gruppe (für die Wert-Sortierung). */
  maxPrice: number | null;
  /** 0..100 — je höher, desto dringender. */
  priority: number;
  /** Kurzbegründung für die Sortierung, wird in der Liste angezeigt. */
  priorityReason: string;
}

function primaryImage(product: Product): string | null {
  for (const img of product.details?.images || []) {
    const raw = (img as unknown as { url_or_base64?: unknown; url?: unknown }).url_or_base64;
    const src =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && typeof (raw as { url?: unknown }).url === "string"
          ? (raw as { url: string }).url
          : typeof (img as unknown as { url?: unknown }).url === "string"
            ? ((img as unknown as { url: string }).url)
            : null;
    if (src && src.startsWith("http")) return src;
  }
  return null;
}

function toMember(id: string, product: Product | undefined): DuplicateMember {
  if (!product) {
    return {
      id, name: "", sku: "", ean: "", imageUrl: null, available: 0, physical: 0,
      binCode: null, price: null, listedEbay: false, listedKaufland: false,
      createdAt: null, missing: true,
    };
  }
  const listing = product.ops?.listingStatus || {};
  const price = product.details?.pricing?.sellPrice;
  return {
    id,
    name: product.identification?.name || "",
    sku: product.identification?.sku || "",
    ean:
      product.details?.identifiers?.ean ||
      product.details?.identifiers?.gtin ||
      (product.identification?.barcodes || [])[0] ||
      "",
    imageUrl: primaryImage(product),
    available: getProductAvailableQuantity(product),
    physical: getProductPhysicalQuantity(product),
    binCode: getProductBinCode(product),
    price: typeof price === "number" && Number.isFinite(price) ? price : null,
    listedEbay: listing.ebay === "active",
    listedKaufland: listing.kaufland === "active",
    createdAt: (product.ops as { created_iso?: string } | undefined)?.created_iso || null,
    missing: false,
  };
}

/**
 * Dringlichkeit einer Gruppe.
 *
 * Reihenfolge der Schwere, aus dem Tagesgeschäft abgeleitet:
 * 1. Mehrere Einträge stehen ONLINE — der Käufer sieht denselben Artikel
 *    doppelt, und beide Angebote führen eigenen Bestand. Das ist der Fall, der
 *    zu Überverkäufen führt.
 * 2. Mehrere Einträge haben BESTAND — die Ware liegt auf zwei Karteikarten,
 *    jede Zählung wird falsch.
 * 3. Alles andere ist Aufräumarbeit ohne Geldwirkung.
 */
export function scoreGroup(group: {
  members: DuplicateMember[];
  multipleListed: boolean;
  membersWithStock: number;
  totalStock: number;
}): { priority: number; priorityReason: string } {
  if (group.multipleListed) {
    return { priority: 100, priorityReason: "Mehrfach online — Überverkauf möglich" };
  }
  if (group.membersWithStock >= 2) {
    return { priority: 80, priorityReason: "Bestand auf mehreren Einträgen" };
  }
  if (group.totalStock > 0) {
    return { priority: 50, priorityReason: "Mit Bestand" };
  }
  return { priority: 10, priorityReason: "Ohne Bestand" };
}

export function enrichDuplicateGroups(
  groups: DuplicateGroupInput[],
  products: Product[]
): EnrichedDuplicateGroup[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  return groups.map((g) => {
    const members = g.productIds.map((id) => toMember(id, byId.get(id)));
    const totalStock = members.reduce((s, m) => s + m.physical, 0);
    const membersWithStock = members.filter((m) => m.physical > 0).length;
    const listedCount = members.filter((m) => m.listedEbay || m.listedKaufland).length;
    const preise = members.map((m) => m.price).filter((p): p is number => p != null);
    const base = {
      members,
      totalStock,
      membersWithStock,
      multipleListed: listedCount >= 2,
      anyListed: listedCount > 0,
      maxPrice: preise.length ? Math.max(...preise) : null,
    };
    return { type: g.type, key: g.key, ...base, ...scoreGroup(base) };
  });
}

export type DuplicateSort = "prioritaet" | "bestand" | "wert" | "anzahl" | "name";

export interface DuplicateFilters {
  suche: string;
  typ: string;
  bestand: "alle" | "mit" | "ohne";
  online: "alle" | "gelistet" | "nichtGelistet";
}

export const DUPLICATE_FILTER_DEFAULTS: DuplicateFilters = {
  suche: "",
  typ: "alle",
  bestand: "alle",
  online: "alle",
};

export function filterAndSortGroups(
  groups: EnrichedDuplicateGroup[],
  filters: DuplicateFilters,
  sort: DuplicateSort
): EnrichedDuplicateGroup[] {
  const q = filters.suche.trim().toLowerCase();
  const gefiltert = groups.filter((g) => {
    if (filters.typ !== "alle" && g.type !== filters.typ) return false;
    if (filters.bestand === "mit" && g.totalStock <= 0) return false;
    if (filters.bestand === "ohne" && g.totalStock > 0) return false;
    if (filters.online === "gelistet" && !g.anyListed) return false;
    if (filters.online === "nichtGelistet" && g.anyListed) return false;
    if (!q) return true;
    if (g.key.toLowerCase().includes(q)) return true;
    return g.members.some(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.sku.toLowerCase().includes(q) ||
        m.ean.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q)
    );
  });

  const sortiert = [...gefiltert];
  sortiert.sort((a, b) => {
    switch (sort) {
      case "bestand":
        return b.totalStock - a.totalStock || b.priority - a.priority;
      case "wert":
        return (b.maxPrice ?? -1) - (a.maxPrice ?? -1) || b.priority - a.priority;
      case "anzahl":
        return b.members.length - a.members.length || b.priority - a.priority;
      case "name":
        return (a.members[0]?.name || "").localeCompare(b.members[0]?.name || "", "de");
      case "prioritaet":
      default:
        // Zweitkriterium ist Pflicht: bei Gleichstand entschiede sonst die
        // zufällige Server-Reihenfolge, und die Liste springt bei jedem Laden.
        return b.priority - a.priority || b.totalStock - a.totalStock || a.key.localeCompare(b.key);
    }
  });
  return sortiert;
}

/** Zahlen für die Kopfzeile — beantwortet "womit fange ich an?". */
export function summarizeGroups(groups: EnrichedDuplicateGroup[]) {
  return {
    gruppen: groups.length,
    mehrfachOnline: groups.filter((g) => g.multipleListed).length,
    mitBestand: groups.filter((g) => g.totalStock > 0).length,
    artikel: groups.reduce((s, g) => s + g.members.length, 0),
  };
}
