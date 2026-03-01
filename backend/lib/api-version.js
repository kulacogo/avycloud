// API-Versionierung: Legacy-Routen werden auf v1 gemappt
// Neue Features nur in versionierten Routen
const API_VERSIONS = {
  current: 'v1',
  supported: ['v1'],
  deprecated: [], // Legacy-Routen ohne Version-Prefix
};

module.exports = { API_VERSIONS };
