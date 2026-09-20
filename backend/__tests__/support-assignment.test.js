const { configureSupportAssignment } = require('../scripts/configure-support-assignment');
function fakeDb({ user = { tenantId: 'default' }, current = null } = {}) {
  const writes = [];
  return { writes, collection: (collection) => ({ doc: () => ({
    get: async () => ({ exists: Boolean(collection === 'users' ? user : current), data: () => collection === 'users' ? user : current }),
    create: async (data) => { writes.push(data); },
  }) }) };
}
it('ändert im Dry-run weder Konto noch Zuordnung; schreibt beim Apply nur die fachliche Zuständigkeit', async () => {
  const db = fakeDb();
  const args = { db, tenantId: 'default', uid: 'yasemin' };
  expect((await configureSupportAssignment(args)).status).toBe('dry-run');
  expect(db.writes).toHaveLength(0);
  expect((await configureSupportAssignment({ ...args, apply: true })).status).toBe('created');
  expect(db.writes[0]).toMatchObject({ tenantId: 'default', responsibleUid: 'yasemin', exclusive: true, confirmation: 'explicit_owner_instruction' });
  expect(db.writes[0].roles).toBeUndefined();
});
it('überschreibt keine bestehende Zuständigkeit und lehnt fremde/deaktivierte Konten ab', async () => {
  for (const setup of [{ current: { tenantId: 'default', responsibleUid: 'other' } }, { user: { tenantId: 'other' } }, { user: { tenantId: 'default', disabled: true } }]) {
    const db = fakeDb(setup);
    await expect(configureSupportAssignment({ db, tenantId: 'default', uid: 'yasemin', apply: true })).rejects.toThrow();
    expect(db.writes).toHaveLength(0);
  }
});
it('ist bei derselben bestätigten Zuordnung idempotent', async () => {
  const db = fakeDb({ current: { tenantId: 'default', responsibleUid: 'yasemin', exclusive: true } });
  expect((await configureSupportAssignment({ db, tenantId: 'default', uid: 'yasemin', apply: true })).status).toBe('unchanged');
  expect(db.writes).toHaveLength(0);
});
