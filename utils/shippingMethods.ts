import type { ShippingMethod } from "../types";

/**
 * EINE Darstellung für alle Versandmethoden-Dropdowns (Versandregeln in den
 * Einstellungen, manuelle Auswahl am Auftrag, Versand-Ansicht). Die Listen
 * müssen identisch sein: gleiche Quelle (/api/shipping-methods, ungefiltert),
 * gleiche Gruppierung, gleiche Reihenfolge, gleiche Beschriftung (2026-07-20).
 */

const CARRIER_DISPLAY_NAMES: Record<string, string> = {
  dhl_de: "DHL",
  dhl: "DHL",
  dhl_express: "DHL Express",
  dp: "Deutsche Post",
  deutsche_post: "Deutsche Post",
  dpd: "DPD",
  hermes: "Hermes",
  hermes_de: "Hermes",
  sendcloud: "SendCloud",
};

export function carrierDisplayName(
  method: Pick<ShippingMethod, "carrier" | "carrierName">,
): string {
  const code = (method.carrierName || method.carrier || "").toLowerCase();
  return (
    CARRIER_DISPLAY_NAMES[code] ||
    (method.carrierName || method.carrier || "Sonstige").toUpperCase()
  );
}

/** Options-Beschriftung inkl. Gewichtsspanne — überall gleich. */
export function shippingMethodOptionLabel(method: ShippingMethod): string {
  const { minWeight, maxWeight } = method;
  if (minWeight == null || maxWeight == null || (!minWeight && !maxWeight)) {
    return method.name;
  }
  return `${method.name} (${minWeight}–${maxWeight} kg)`;
}

/**
 * Gruppiert für <optgroup>-Rendering. Die Reihenfolge kommt sortiert vom
 * Backend (carrier, dann name) und bleibt erhalten (Map = insertion order).
 */
export function groupShippingMethods(
  methods: ShippingMethod[],
): Array<[string, ShippingMethod[]]> {
  const groups = new Map<string, ShippingMethod[]>();
  for (const m of methods) {
    const key = carrierDisplayName(m);
    const list = groups.get(key);
    if (list) {
      list.push(m);
    } else {
      groups.set(key, [m]);
    }
  }
  return Array.from(groups.entries());
}
