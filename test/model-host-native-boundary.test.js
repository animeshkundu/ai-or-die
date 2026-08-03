'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

describe('model-host native module boundary', function () {
  it('does not load either native model addon in the core module registry', function () {
    require('../src/server');
    const loaded = Object.keys(require.cache);
    assert.ok(!loaded.some((file) => file.includes('sherpa-onnx-node')));
    assert.ok(!loaded.some((file) => file.includes('node-llama-cpp')));
  });

  it('keeps native addon imports in host entrypoints, not engine modules', function () {
    const fs = require('fs');
    const sttEngine = fs.readFileSync(require.resolve('../src/stt-engine'), 'utf8');
    const stickyEngine = fs.readFileSync(require.resolve('../src/sticky-note-engine'), 'utf8');
    const sttHost = fs.readFileSync(require.resolve('../src/stt-host'), 'utf8');
    const stickyHost = fs.readFileSync(require.resolve('../src/sticky-note-host'), 'utf8');
    assert.ok(!sttEngine.includes("require('sherpa-onnx-node')"));
    assert.ok(!stickyEngine.includes("import('node-llama-cpp')"));
    assert.ok(sttHost.includes("require('sherpa-onnx-node')"));
    assert.ok(stickyHost.includes("import('node-llama-cpp')"));
  });

  it('loads installed native addons in a child without entering the core registry', function () {
    const platform = os.platform() === 'win32' ? 'win' : os.platform();
    const nativeDir = path.join(
      path.resolve(__dirname, '..', 'node_modules'),
      `sherpa-onnx-${platform}-${os.arch()}`
    );
    const env = { ...process.env };
    if (os.platform() === 'win32') env.PATH = nativeDir + path.delimiter + (env.PATH || '');
    else if (os.platform() === 'linux') env.LD_LIBRARY_PATH = nativeDir + path.delimiter + (env.LD_LIBRARY_PATH || '');
    else if (os.platform() === 'darwin') env.DYLD_LIBRARY_PATH = nativeDir + path.delimiter + (env.DYLD_LIBRARY_PATH || '');
    const probes = [
      ['sherpa-onnx-node', "require('sherpa-onnx-node'); process.stdout.write('loaded')"],
    ];
    try {
      require.resolve('node-llama-cpp');
      probes.push([
        'node-llama-cpp',
        "import('node-llama-cpp').then(() => { process.stdout.write('loaded'); process.exit(0); })",
      ]);
    } catch (_) {
      // Optional binding absent: sticky notes correctly degrade to unavailable.
    }
    for (const [name, script] of probes) {
      const output = execFileSync(process.execPath, ['-e', script], {
        cwd: require('path').resolve(__dirname, '..'),
        env,
        encoding: 'utf8',
        timeout: 30000,
      });
      assert.strictEqual(output, 'loaded', `${name} loads in the isolated child`);
      assert.ok(
        !Object.keys(require.cache).some((file) => file.includes(name)),
        `${name} remains absent from the core registry`
      );
    }
  });
});
