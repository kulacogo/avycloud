'use strict';
const path = require('node:path');
const os = require('node:os');

function dataDirectory(platform = process.platform, env = process.env, home = os.homedir()) {
  if (env.AGENT_DATA_DIR) return env.AGENT_DATA_DIR;
  if (platform === 'win32') return path.win32.join(env.ProgramData || 'C:\\ProgramData', 'AvyCloud Print Agent');
  return path.join(home, 'Library', 'Application Support', 'AvyCloud Print Agent');
}
module.exports = { dataDirectory };
