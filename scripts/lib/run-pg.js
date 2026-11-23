import { spawn } from 'node:child_process';

/**
 * Run a PostgreSQL CLI tool (`pg_dump`, `pg_restore`) and collect its stderr.
 *
 * Rejects with an Error carrying the tool's own message, so the caller can add
 * Russian context around a concrete libpq diagnostic. A missing executable
 * propagates the original `ENOENT` error untouched: that case needs different
 * advice ("add PostgreSQL bin to PATH") than a failed command.
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<string>} captured stderr, empty on a clean run
 */
export function runPgCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // The dump goes to a file and the progress text is not useful to a
      // scheduler, so only stderr is read back for the failure message.
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      // Keep the tail: libpq prints several lines and the last one explains the
      // failure, while an unbounded buffer could grow on a noisy server.
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(stderr);
        return;
      }
      reject(new Error(stderr.trim() || `код ${code ?? signal}`));
    });
  });
}
