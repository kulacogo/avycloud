'use strict';

// Guards the web/worker split flag. RUN_BACKGROUND_JOBS gates ALL runners + cron
// jobs onto the dedicated worker so they never compete with user requests for a
// Cloud Run instance slot. Default MUST stay true (inert) so any deployment
// without the flag keeps running everything (no silent loss of safety-net crons).

const { shouldRunBackgroundJobs } = require('../lib/process-role');

describe('shouldRunBackgroundJobs', () => {
  it('defaults to true when the flag is unset (legacy single-process behaviour)', () => {
    expect(shouldRunBackgroundJobs({})).toBe(true);
  });

  it('is true on the worker (RUN_BACKGROUND_JOBS=true)', () => {
    expect(shouldRunBackgroundJobs({ RUN_BACKGROUND_JOBS: 'true' })).toBe(true);
  });

  it('is FALSE only on the explicit request-only opt-out (=false)', () => {
    expect(shouldRunBackgroundJobs({ RUN_BACKGROUND_JOBS: 'false' })).toBe(false);
  });

  it('treats any non-"false" value as true (no accidental disable from typos)', () => {
    expect(shouldRunBackgroundJobs({ RUN_BACKGROUND_JOBS: '0' })).toBe(true);
    expect(shouldRunBackgroundJobs({ RUN_BACKGROUND_JOBS: 'no' })).toBe(true);
    expect(shouldRunBackgroundJobs({ RUN_BACKGROUND_JOBS: 'FALSE' })).toBe(true);
    expect(shouldRunBackgroundJobs({ RUN_BACKGROUND_JOBS: '' })).toBe(true);
  });
});
