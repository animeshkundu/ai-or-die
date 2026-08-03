'use strict';

const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');

try {
  const oneByte = Buffer.allocUnsafe(1);
  const armed = fs.readSync(workerData.fd, oneByte, 0, 1, null);
  if (armed !== 1) throw new Error('model-host liveness pipe closed before arming');
  parentPort.postMessage({ type: 'armed' });
  for (;;) {
    const read = fs.readSync(workerData.fd, oneByte, 0, 1, null);
    if (read === 0) {
      try {
        process.kill(process.pid, 'SIGKILL');
      } catch (error) {
        parentPort.postMessage({
          type: 'failed',
          message: (error && error.message) || 'model-host self-termination failed',
        });
      }
      break;
    }
  }
} catch (error) {
  parentPort.postMessage({
    type: 'failed',
    message: (error && error.message) || 'model-host liveness watchdog failed',
  });
}
