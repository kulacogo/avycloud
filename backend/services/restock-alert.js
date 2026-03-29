'use strict';

const { firestore } = require('../lib/firestore');

const ALERT_COLLECTION = 'restock_alerts';
const MOVEMENTS_COLLECTION = 'warehouse_movements';

/**
 * Findet Retouren die als a_ware/b_ware eingestuft wurden,
 * aber nach 24h immer noch nicht physisch eingebucht sind.
 *
 * Prüft ob ein restock_alert für das jeweilige warehouse_movement
 * bereits existiert. Wenn nicht → Alert erzeugen.
 * Manuelle Einbuchung markiert den Alert als 'resolved' (via UI, zukünftig).
 */
async function checkPendingRestocks({ tenantId = 'default' } = {}) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const alerts = [];

  // 1. Finde restock_return Movements die älter als 24h sind
  const movSnap = await firestore.collection(MOVEMENTS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('type', '==', 'restock_return')
    .where('createdAt', '<=', cutoff)
    .limit(200)
    .get();

  if (movSnap.empty) return { checked: 0, newAlerts: 0 };

  // 2. Für jedes Movement prüfen ob Alert bereits existiert
  for (const movDoc of movSnap.docs) {
    const mov = movDoc.data();
    const condition = mov.condition || '';

    // Nur a_ware und b_ware — c_ware wird entsorgt
    if (condition !== 'a_ware' && condition !== 'b_ware') continue;

    // Prüfe ob Alert für dieses Movement schon existiert
    const existingAlert = await firestore.collection(ALERT_COLLECTION)
      .where('movementId', '==', movDoc.id)
      .limit(1)
      .get();

    if (!existingAlert.empty) continue; // Alert existiert schon

    // Alert erzeugen
    const alert = {
      tenantId,
      movementId: movDoc.id,
      returnId: mov.returnId || null,
      orderId: mov.orderId || null,
      productSku: mov.productSku || null,
      productName: mov.productName || null,
      quantity: mov.quantity || 1,
      condition,
      status: 'pending',
      restockMovementCreatedAt: mov.createdAt,
      createdAt: new Date().toISOString(),
    };

    await firestore.collection(ALERT_COLLECTION).add(alert);
    alerts.push(alert);
    console.log(
      `[restock-alert] NEW: SKU=${mov.productSku} qty=${mov.quantity} condition=${condition} returnId=${mov.returnId} — pending since ${mov.createdAt}`
    );
  }

  return { checked: movSnap.docs.length, newAlerts: alerts.length };
}

module.exports = { checkPendingRestocks };
