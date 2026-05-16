// globals: true in vitest.config.js — describe/it/expect/vi are global
//
// Oversell-Invariante Regression-Test (P2.5, siehe Plan)
//
// Dieser Test encodiert die nicht-verhandelbare Regel aus CLAUDE.md Punkt 10:
//   "Kein Code-Pfad darf products_v2.inventory.quantity mutieren ohne
//    saveProductV2() UND emitSyncEvent('stock:changed', ...)."
//
// Statt eines E2E-Tests (der Firestore-Emulator braeuchte) verifiziert er,
// dass ALLE Bausteine der Anti-Oversell-Pipeline existieren und ihre Contracts
// erfuellen. Wenn jemand spaeter eine dieser Komponenten entfernt oder
// umbenennt, schlaegt dieser Test an — mit einer klaren Erklaerung, welcher
// Baustein der Oversell-Prevention entfernt wurde.

const fs = require('fs');
const path = require('path');

describe('Oversell-Invariante — Pipeline-Guard', () => {
  describe('Code-Artefakte existieren', () => {
    it('stock-change-events.notifyStockChange ist exportiert', () => {
      const mod = require('../lib/stock-change-events');
      expect(typeof mod.notifyStockChange).toBe('function');
    });

    it('stock-failure-drain.drainStockFailures ist exportiert', () => {
      const mod = require('../services/stock-failure-drain');
      expect(typeof mod.drainStockFailures).toBe('function');
      expect(typeof mod.MAX_ATTEMPTS).toBe('number');
      expect(mod.MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
    });

    it('order-state-machine exportiert processShippedOrder UND processCancelledOrder', () => {
      const mod = require('../services/order-state-machine');
      expect(typeof mod.processShippedOrder).toBe('function');
      expect(typeof mod.processCancelledOrder).toBe('function');
      expect(typeof mod.transitionOrder).toBe('function');
    });

    it('transitionOrder akzeptiert force-Parameter (fuer Intake-Reconciliation)', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'order-state-machine.js'), 'utf8');
      expect(src).toMatch(/async function transitionOrder\([^)]*force\s*=/);
    });

    it('sync-event-bus hat stock:changed-Listener', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'sync-event-bus.js'), 'utf8');
      expect(src).toMatch(/stock:changed/);
    });

    it('stock-sync-dispatcher.syncStockWithRetry existiert', () => {
      const mod = require('../services/stock-sync-dispatcher');
      expect(typeof mod.syncStockWithRetry).toBe('function');
      expect(typeof mod.syncStockToAllChannels).toBe('function');
    });
  });

  describe('Admin-Endpoints sind registriert', () => {
    it('POST /stock/force-resync ist in routes/admin.js definiert', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
      expect(src).toMatch(/\/stock\/force-resync/);
    });

    it('POST /stock/drain-failures ist in routes/admin.js definiert', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');
      expect(src).toMatch(/\/stock\/drain-failures/);
    });
  });

  describe('Intake-Services umgehen transitionOrder NICHT', () => {
    it('kaufland-intake: omsStatus-Direct-Write ist nur in SAVE-new-order-Bloecken', () => {
      // Wir suchen nach: orderRef.update({ ..., omsStatus: ... }) in einem reconcile-block.
      // Legitim ist: omsStatus in neuen Order-Documents (initial save), NICHT in Status-Updates.
      const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'order-intake-kaufland.js'), 'utf8');
      // Reconcile-Pfad MUSS transitionOrder nutzen
      expect(src).toMatch(/transitionOrder\s*\(/);
      // Reconcile-Pfad darf KEIN updateFields = \{ ..., omsStatus: ... \} Pattern haben.
      // Negative assertion: das alte "Andere Status ... ref.update() bleibt OK" Kommentar darf nicht mehr existieren.
      expect(src).not.toMatch(/Andere Status.*ref\.update\(\) bleibt OK/);
    });

    it('ebay-intake: omsStatus-Direct-Write ist nur in SAVE-new-order-Bloecken', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'order-intake-ebay.js'), 'utf8');
      expect(src).toMatch(/transitionOrder\s*\(/);
      expect(src).not.toMatch(/Andere Status.*ref\.update\(\) bleibt OK/);
    });
  });

  describe('CLAUDE.md hat die drei Oversell-Regeln', () => {
    const claudeMd = fs.readFileSync(path.join(__dirname, '..', '..', 'CLAUDE.md'), 'utf8');

    it('enthaelt OVERSELL-VERBOT (Punkt 10)', () => {
      expect(claudeMd).toMatch(/OVERSELL-VERBOT/i);
      expect(claudeMd).toMatch(/stock_operation_failures/);
      expect(claudeMd).toMatch(/Drain-Worker/);
    });

    it('enthaelt Direct-Write-Verbot (Punkt 11)', () => {
      expect(claudeMd).toMatch(/Kein `?omsStatus`?-Direct-Write/);
      expect(claudeMd).toMatch(/transitionOrder/);
    });

    it('enthaelt Distributed-Lock-Regel (Punkt 12)', () => {
      expect(claudeMd).toMatch(/In-Memory-Stock-Lock/);
      expect(claudeMd).toMatch(/STOCK_LOCK_BACKEND/);
    });
  });

  describe('Drain-Scheduler ist in index.js registriert', () => {
    it('index.js startet stock-failure-drain periodisch', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
      expect(src).toMatch(/stock-failure-drain/);
      expect(src).toMatch(/drainStockFailures/);
    });
  });

  describe('Stock-Change-Event wird aus saveProductV2 und warehouse emittiert', () => {
    it('product-store.js ruft notifyStockChange', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'product-store.js'), 'utf8');
      expect(src).toMatch(/notifyStockChange/);
      expect(src).toMatch(/stock-change-events/);
    });

    it('warehouse.js ruft notifyStockChange nach refreshProductInventory', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'warehouse.js'), 'utf8');
      expect(src).toMatch(/notifyStockChange/);
      expect(src).toMatch(/stock-change-events/);
    });

    it('marketplace.js enthält keinen inventory.quantity-Direct-Write im Kaufland-Reconcile', () => {
      // Plan-D.0d: die Kaufland-Listings-Sync-Logik wohnt jetzt im Service
      // `services/kaufland-listings-sync.js`. Marketplace-Route delegiert nur.
      // Wir prüfen daher BEIDE Dateien: weder marketplace.js noch der Service
      // dürfen einen inventory.quantity-Direct-Write enthalten, und das
      // drift-Signal MUSS in einer von beiden weiter existieren.
      const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'marketplace.js'), 'utf8');
      const serviceSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'kaufland-listings-sync.js'), 'utf8');
      expect(routeSrc).not.toMatch(/reconBatch\.update\([\s\S]*inventory\.quantity/);
      expect(serviceSrc).not.toMatch(/reconBatch\.update\([\s\S]*inventory\.quantity/);
      const combined = `${routeSrc}\n${serviceSrc}`;
      expect(combined).toMatch(/kaufland-drift-detected/);
    });
  });

  describe('Order-State-Machine schreibt Failures fuer Drain-Recovery', () => {
    it('_onOrderShipped persistiert failures in stock_operation_failures mit status=pending', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'order-state-machine.js'), 'utf8');
      expect(src).toMatch(/stock_operation_failures/);
      expect(src).toMatch(/status:\s*['"]pending['"]/);
      // Phase B muss IMMER laufen (Kommentar "runs ALWAYS" oder equivalent) —
      // wenn jemand den always-Pfad entfernt, breakt das unsere Retry-Strategie.
      expect(src).toMatch(/Phase B/);
    });
  });
});
