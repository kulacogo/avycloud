'use strict';
require('./api/_patchGcp');
require('./api/_setupMocks');
const { __test__buildPickHint: hint } = require('../services/pick-hints');
it('returns remaining BIN stock without subtracting central order progress again', () => {
  const product = { id: 'p1', inventory: { quantity: 3 }, storage: { binCode: 'A', quantity: 3 }, storageBins: [{ code: 'A', quantity: 1 }, { code: 'B', quantity: 2 }] };
  expect(hint(product, {}).bins).toEqual([{ code: 'A', quantity: 1 }, { code: 'B', quantity: 2 }]);
});
it('preserves legacy single-BIN stock when no storageBins exist', () => {
  expect(hint({ id: 'p1', storage: { binCode: 'A', quantity: 2 } }, {}).bins).toEqual([{ code: 'A', quantity: 2 }]);
});
