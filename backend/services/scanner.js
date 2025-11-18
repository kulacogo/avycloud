const { spawn } = require('child_process');

function parseArgs(raw = '') {
  if (!raw || typeof raw !== 'string') {
    return [];
  }
  const regex = /(?:[^\s"]+|"[^"]*")+/g;
  const matches = raw.match(regex) || [];
  return matches.map((segment) => segment.replace(/^"(.*)"$/, '$1'));
}

async function scanToBuffer() {
  const command = process.env.SCAN_COMMAND || 'scanimage';
  const rawArgs = process.env.SCAN_ARGS || '--format=png --mode Color --resolution 300';
  const args = parseArgs(rawArgs);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(new Error(`scanimage exited with code ${code}: ${stderr}`));
      }
    });
  });
}

module.exports = {
  scanToBuffer,
};

