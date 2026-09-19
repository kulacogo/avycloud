'use strict';

const getUserProfile = vi.fn();
const verifyIdToken = vi.fn();
function patch(name, exports) {
  const file = require.resolve(name);
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
patch('../lib/firebaseAdmin', { getAdminAuth: () => ({ verifyIdToken }) });
patch('../lib/rbac', { getUserProfile });
const { verifyRequestUser } = require('../lib/auth');
const req = { header: () => 'Bearer verified-token' };
beforeEach(() => {
  verifyIdToken.mockResolvedValue({ uid: 'personal-user', email: 'employee@trendocean.de', email_verified: true });
  getUserProfile.mockResolvedValue({ accessRole: 'employee', disabled: false });
});
it('gibt die geprüfte persönliche Identität samt Profil für denselben Request weiter', async () => {
  const user = await verifyRequestUser(req);
  expect(verifyIdToken).toHaveBeenCalledWith('verified-token', true);
  expect(user.uid).toBe('personal-user');
  expect(user.accessProfile.accessRole).toBe('employee');
});
it('sperrt deaktivierte Sammelkonten bereits vor jedem nur-authentifizierten Endpunkt', async () => {
  getUserProfile.mockResolvedValue({ disabled: true, roles: ['admin'] });
  await expect(verifyRequestUser(req)).rejects.toMatchObject({ statusCode: 403 });
});
it('auch der Bootstrap-Inhaber umgeht eine explizite Kontosperre nicht', async () => {
  verifyIdToken.mockResolvedValue({ uid: 'owner', email: 'admin@trendocean.de', email_verified: true });
  getUserProfile.mockResolvedValue({ disabled: true });
  await expect(verifyRequestUser(req)).rejects.toMatchObject({ statusCode: 403 });
});
