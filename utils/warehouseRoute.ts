export const WAREHOUSE_ZONES_ROUTE = ['X', 'XS', 'S', 'M', 'L', 'XL', 'XQ'] as const;
export const WAREHOUSE_ETAGEN_ROUTE = ['GA', 'EG', 'UG'] as const;

const ZONE_PREFIXES = [...WAREHOUSE_ZONES_ROUTE].sort((a, b) => b.length - a.length);

export type ParsedWarehouseBinCode = {
  zone: string;
  etage: string;
  gang: number;
  regal: number;
  ebene: string;
};

export function parseWarehouseBinCode(code?: string | null): ParsedWarehouseBinCode | null {
  const raw = (code || '').toString().trim().toUpperCase();
  if (!raw) return null;

  const zone = ZONE_PREFIXES.find((z) => raw.startsWith(z)) || null;
  if (!zone) return null;

  const rest = raw.slice(zone.length);
  const etage = rest.slice(0, 2);
  if (!WAREHOUSE_ETAGEN_ROUTE.includes(etage as any)) return null;

  const gang = Number.parseInt(rest.slice(2, 4), 10);
  const regal = Number.parseInt(rest.slice(4, 6), 10);
  const ebene = rest.slice(6, 7);
  if (!Number.isFinite(gang) || !Number.isFinite(regal) || !ebene) return null;

  return { zone, etage, gang, regal, ebene };
}

export function compareBinCodesForPickRoute(a?: string | null, b?: string | null): number {
  const pa = parseWarehouseBinCode(a);
  const pb = parseWarehouseBinCode(b);
  if (!pa && !pb) return String(a || '').localeCompare(String(b || ''), 'de', { sensitivity: 'base' });
  if (!pa) return 1;
  if (!pb) return -1;

  const zoneA = WAREHOUSE_ZONES_ROUTE.indexOf(pa.zone as any);
  const zoneB = WAREHOUSE_ZONES_ROUTE.indexOf(pb.zone as any);
  if (zoneA !== zoneB) return zoneA - zoneB;

  const etageA = WAREHOUSE_ETAGEN_ROUTE.indexOf(pa.etage as any);
  const etageB = WAREHOUSE_ETAGEN_ROUTE.indexOf(pb.etage as any);
  if (etageA !== etageB) return etageA - etageB;

  // Route: higher gang/regal first (matches typical "back to front" walk and the user's example)
  if (pa.gang !== pb.gang) return pb.gang - pa.gang;
  if (pa.regal !== pb.regal) return pb.regal - pa.regal;

  return pa.ebene.localeCompare(pb.ebene, 'de', { sensitivity: 'base' });
}


