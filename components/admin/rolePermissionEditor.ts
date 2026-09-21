import { PERMISSION_MODULES } from "./roleCatalog.ts";

export type PermissionMatrix = Record<string, Record<string, boolean>>;
const entries = PERMISSION_MODULES.flatMap((module) =>
  module.actions.map((action) => ({
    ...action,
    module: module.id,
    key: `${module.id}.${action.action}`,
  })),
);
export const permissionEnabled = (
  permissions: PermissionMatrix,
  module: string,
  action: string,
) => permissions["*"]?.["*"] === true || permissions[module]?.[action] === true;

// Workflows include prerequisites; removing a prerequisite removes dependent actions.
export function togglePermission(
  permissions: PermissionMatrix,
  module: string,
  action: string,
  enabled: boolean,
): PermissionMatrix {
  const next = Object.fromEntries(
    Object.entries(permissions).map(([key, value]) => [key, { ...value }]),
  );
  const set = (key: string, value: boolean) => {
    const entry = entries.find((item) => item.key === key);
    if (!entry) return;
    next[entry.module] = { ...next[entry.module], [entry.action]: value };
    if (value) entry.requires.forEach((dependency) => set(dependency, true));
  };
  set(`${module}.${action}`, enabled);
  if (!enabled) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of entries) {
        if (
          permissionEnabled(next, entry.module, entry.action) &&
          entry.requires.some((key) => {
            const dependency = entries.find((item) => item.key === key)!;
            return !permissionEnabled(
              next,
              dependency.module,
              dependency.action,
            );
          })
        ) {
          set(entry.key, false);
          changed = true;
        }
      }
    }
  }
  return next;
}
export const samePermissions = (a: PermissionMatrix, b: PermissionMatrix) =>
  entries.every(
    (entry) =>
      permissionEnabled(a, entry.module, entry.action) ===
      permissionEnabled(b, entry.module, entry.action),
  );
