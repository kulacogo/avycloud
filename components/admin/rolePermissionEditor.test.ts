import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { togglePermission, samePermissions } from "./rolePermissionEditor.ts";
import { PERMISSION_MODULES } from "./roleCatalog.ts";
const require = createRequire(import.meta.url);
const serverCatalog = require("../../backend/lib/access-permission-catalog.json");
const { defaultRoles } = require("../../backend/lib/access-profiles.js");

test("UI exposes exactly the editable server permissions, without historical groups or user overrides", () => {
  assert.deepEqual(PERMISSION_MODULES, serverCatalog);
  assert.ok(!JSON.stringify(PERMISSION_MODULES).includes("groups."));
});
test("invoice creation includes invoice and order reads, but no financial reports", () => {
  const before = {};
  const after = togglePermission(before, "invoices", "write", true);
  assert.deepEqual(after, {
    invoices: { write: true, read: true },
    orders: { read: true },
  });
  assert.deepEqual(before, {});
});
test("revoking order access removes invoice creation and dependent warehouse workflows", () => {
  const before = defaultRoles().manager.permissions;
  const after = togglePermission(before, "orders", "read", false);
  assert.equal(after.invoices.write, false);
  assert.equal(after.orders.pack, false);
  assert.equal(after.orders.ship, false);
  assert.equal(before.orders.pack, true);
  assert.equal(after.products.write, true);
});
test("enrichment prerequisites work transitively and reverting removes a dirty draft", () => {
  const after = togglePermission({}, "identify", "run", true);
  assert.equal(after.products.write, true);
  assert.equal(after.products.read, true);
  assert.equal(after.jobs.read, true);
  assert.equal(samePermissions({}, { invoices: { read: false } }), true);
  const defaults = defaultRoles().manager.permissions;
  assert.equal(
    samePermissions(
      defaults,
      togglePermission(
        togglePermission(defaults, "invoices", "write", false),
        "invoices",
        "write",
        true,
      ),
    ),
    true,
  );
});

test("picking includes stock booking and loses access when booking is revoked", () => {
  const picking = togglePermission({}, "orders", "pick", true);
  assert.equal(picking.warehouse.write, true);
  assert.equal(picking.warehouse.read, true);
  assert.equal(togglePermission(picking, "warehouse", "write", false).orders.pick, false);
});
