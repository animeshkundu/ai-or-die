'use strict';

const assert = require('assert');
const {
  GEOMETRY_LIMITS,
  TerminalGeometryCoordinator,
  normalizeGeometry,
} = require('../src/terminal-geometry-coordinator');

function fixture(options = {}) {
  const session = {};
  const resizes = [];
  const frames = [];
  const rejected = [];
  let active = options.active !== false;
  const coordinator = new TerminalGeometryCoordinator({
    coalesceMs: options.coalesceMs == null ? 0 : options.coalesceMs,
    isActive: () => active,
    applyResize: async (_sessionId, geometry) => {
      resizes.push({ ...geometry });
      if (options.resizeError) throw options.resizeError;
    },
    broadcast: (_sessionId, frame) => frames.push(frame),
    reject: (_connectionId, frame) => rejected.push(frame),
  });
  coordinator.initializeSession('s1', session, { restored: options.restored });
  return {
    coordinator,
    session,
    resizes,
    frames,
    rejected,
    setActive(value) { active = value; },
  };
}

describe('TerminalGeometryCoordinator', function () {
  it('accepts only finite bounded integer geometry', function () {
    assert.deepStrictEqual(normalizeGeometry(20, 5), { cols: 20, rows: 5 });
    assert.deepStrictEqual(normalizeGeometry(1000, 500), { cols: 1000, rows: 500 });
    for (const value of [
      [19, 5], [20, 4], [1001, 5], [20, 501], [20.5, 5],
      [20, NaN], [Infinity, 5], [0, 0], ['80', 24],
    ]) {
      assert.strictEqual(normalizeGeometry(value[0], value[1]), null);
    }
    assert.deepStrictEqual(GEOMETRY_LIMITS, {
      minCols: 20,
      maxCols: 1000,
      minRows: 5,
      maxRows: 500,
    });
  });

  it('advertising capacity does not transfer an existing lease', async function () {
    const f = fixture();
    await f.coordinator.advertise('s1', 'desktop', 'main', 160, 45);
    assert.deepStrictEqual(f.resizes, [{ cols: 160, rows: 45 }]);
    await f.coordinator.advertise('s1', 'phone', 'main', 40, 38);
    assert.deepStrictEqual(f.resizes, [{ cols: 160, rows: 45 }]);
    assert.deepStrictEqual(f.coordinator.getFrame('s1').owner, {
      connectionId: 'desktop',
      viewId: 'main',
    });
  });

  it('transfers ownership only for a deliberate action and applies before input', async function () {
    const f = fixture();
    const order = [];
    f.coordinator._applyResize = async (_sessionId, geometry) => {
      order.push(`resize:${geometry.cols}x${geometry.rows}`);
      f.resizes.push({ ...geometry });
    };
    await f.coordinator.advertise('s1', 'desktop', 'main', 160, 45);
    await f.coordinator.advertise('s1', 'phone', 'main', 40, 38);
    await f.coordinator.withDeliberateAction('s1', 'phone', 'main', async () => {
      order.push('input');
    });
    assert.deepStrictEqual(order.slice(-2), ['resize:40x38', 'input']);
    assert.deepStrictEqual(f.coordinator.getFrame('s1').owner, {
      connectionId: 'phone',
      viewId: 'main',
    });
  });

  it('applies a deterministic surviving capacity immediately on owner disconnect', async function () {
    const f = fixture();
    await f.coordinator.advertise('s1', 'desktop', 'main', 160, 45);
    await f.coordinator.advertise('s1', 'phone-a', 'main', 40, 38);
    await f.coordinator.advertise('s1', 'phone-b', 'main', 42, 36);
    await f.coordinator.detachConnection('s1', 'desktop');
    assert.deepStrictEqual(f.resizes.at(-1), { cols: 42, rows: 36 });
    assert.deepStrictEqual(f.coordinator.getFrame('s1').owner, {
      connectionId: 'phone-b',
      viewId: 'main',
    });
  });

  it('retains withdrawals as ineligible and preserves applied geometry when nobody survives', async function () {
    const f = fixture();
    await f.coordinator.advertise('s1', 'desktop', 'main', 160, 45);
    const revision = f.coordinator.getFrame('s1').revision;
    await f.coordinator.withdraw('s1', 'desktop', 'main');
    assert.deepStrictEqual(f.resizes, [{ cols: 160, rows: 45 }]);
    const frame = f.coordinator.getFrame('s1');
    assert.deepStrictEqual({ cols: frame.cols, rows: frame.rows }, { cols: 160, rows: 45 });
    assert.strictEqual(frame.owner, null);
    assert(frame.revision > revision);
    await f.coordinator.advertise('s1', 'desktop', 'main', 120, 35);
    assert.deepStrictEqual(f.resizes.at(-1), { cols: 160, rows: 45 });
    assert.strictEqual(f.coordinator.getFrame('s1').owner, null);
    await f.coordinator.takeControl('s1', 'desktop', 'main');
    assert.deepStrictEqual(f.resizes.at(-1), { cols: 120, rows: 35 });
  });

  it('does not commit applied geometry when the PTY resize fails', async function () {
    const f = fixture({ resizeError: new Error('resize failed') });
    await assert.rejects(
      f.coordinator.advertise('s1', 'desktop', 'main', 160, 45),
      /resize failed/
    );
    assert.strictEqual(f.coordinator.getFrame('s1'), null);
    assert.strictEqual(f.session.terminalGeometry.applied, null);
  });

  it('stores owner capacity before spawn and commits only the spawned geometry', async function () {
    const f = fixture({ active: false });
    await f.coordinator.advertise('s1', 'desktop', 'main', 160, 45);
    assert.deepStrictEqual(f.coordinator.getOwnerCapacity('s1'), { cols: 160, rows: 45 });
    assert.strictEqual(f.coordinator.getFrame('s1'), null);
    await f.coordinator.commitSpawn('s1', 160, 45);
    assert.deepStrictEqual(
      { cols: f.coordinator.getFrame('s1').cols, rows: f.coordinator.getFrame('s1').rows },
      { cols: 160, rows: 45 }
    );
  });

  it('bumps epoch and resets revision once when restoring a session', function () {
    const session = {
      terminalGeometry: {
        epoch: 4,
        revision: 12,
        applied: { cols: 100, rows: 30 },
      },
    };
    const coordinator = new TerminalGeometryCoordinator();
    coordinator.initializeSession('s1', session, { restored: true });
    assert.deepStrictEqual(session.terminalGeometry, {
      epoch: 5,
      revision: 0,
      applied: { cols: 100, rows: 30 },
    });
    assert.strictEqual(coordinator.getFrame('s1').owner, null);
  });

  it('broadcasts authoritative geometry before releasing resize-triggered output', async function () {
    const order = [];
    const session = {};
    const coordinator = new TerminalGeometryCoordinator({
      isActive: () => true,
      applyResize: async () => { order.push('resize'); order.push('output-held'); },
      broadcast: () => order.push('geometry-frame'),
      afterBroadcast: () => order.push('output-released'),
    });
    coordinator.initializeSession('s1', session);
    await coordinator.advertise('s1', 'desktop', 'main', 100, 30);
    assert.deepStrictEqual(order, [
      'resize',
      'output-held',
      'geometry-frame',
      'output-released',
    ]);
  });

  it('defers owner advertisements while spawning and reconciles the latest capacity', async function () {
    let active = false;
    const resizes = [];
    const session = {};
    const coordinator = new TerminalGeometryCoordinator({
      isActive: () => active,
      applyResize: async (_sessionId, geometry) => resizes.push({ ...geometry }),
    });
    coordinator.initializeSession('s1', session);
    await coordinator.advertise('s1', 'desktop', 'main', 100, 30);
    await coordinator.advertise('s1', 'desktop', 'main', 120, 35);
    await coordinator.commitSpawn('s1', 100, 30);
    active = true;
    await coordinator.reconcile('s1');
    assert.deepStrictEqual(resizes, [{ cols: 120, rows: 35 }]);
    assert.deepStrictEqual(session.terminalGeometry.applied, { cols: 120, rows: 35 });
  });

  it('does not automatically grant a restored vacant lease', async function () {
    const session = {
      terminalGeometry: {
        epoch: 2,
        revision: 4,
        applied: { cols: 100, rows: 30 },
      },
    };
    const resizes = [];
    const coordinator = new TerminalGeometryCoordinator({
      isActive: () => true,
      applyResize: async (_sessionId, geometry) => resizes.push(geometry),
    });
    coordinator.initializeSession('s1', session, { restored: true });
    await coordinator.advertise('s1', 'desktop', 'main', 120, 35);
    assert.deepStrictEqual(resizes, []);
    assert.strictEqual(coordinator.getFrame('s1').owner, null);
  });

  it('serializes non-claiming input behind an in-flight claim transaction', async function () {
    const order = [];
    let releaseResize;
    const resizeGate = new Promise((resolve) => { releaseResize = resolve; });
    const session = {};
    const coordinator = new TerminalGeometryCoordinator({
      isActive: () => true,
      applyResize: async () => {
        order.push('resize-start');
        await resizeGate;
        order.push('resize-end');
      },
    });
    coordinator.initializeSession('s1', session);
    const advertise = coordinator.advertise('s1', 'desktop', 'main', 100, 30);
    await Promise.resolve();
    const input = coordinator.runSerialized('s1', async () => order.push('mouse-input'));
    releaseResize();
    await Promise.all([advertise, input]);
    assert.deepStrictEqual(order, ['resize-start', 'resize-end', 'mouse-input']);
  });

  it('coalesces owner layout advertisements to the newest capacity', async function () {
    const f = fixture({ coalesceMs: 20 });
    await f.coordinator.advertise('s1', 'desktop', 'main', 100, 30);
    assert.deepStrictEqual(f.resizes, [{ cols: 100, rows: 30 }]);
    await Promise.all([
      f.coordinator.advertise('s1', 'desktop', 'main', 110, 31),
      f.coordinator.advertise('s1', 'desktop', 'main', 120, 32),
      f.coordinator.advertise('s1', 'desktop', 'main', 130, 33),
    ]);
    assert.deepStrictEqual(f.resizes, [{ cols: 100, rows: 30 }]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepStrictEqual(f.resizes, [
      { cols: 100, rows: 30 },
      { cols: 130, rows: 33 },
    ]);
  });

  it('commits a pending owner layout resize before same-owner input', async function () {
    const order = [];
    const f = fixture({ coalesceMs: 20 });
    f.coordinator._applyResize = async (_sessionId, geometry) => {
      order.push(`resize:${geometry.cols}x${geometry.rows}`);
      f.resizes.push({ ...geometry });
    };
    await f.coordinator.advertise('s1', 'desktop', 'main', 100, 30);
    await f.coordinator.advertise('s1', 'desktop', 'main', 120, 32);
    await f.coordinator.withDeliberateAction('s1', 'desktop', 'main', async () => {
      order.push('input');
    });
    assert.deepStrictEqual(order, ['resize:100x30', 'resize:120x32', 'input']);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepStrictEqual(order, ['resize:100x30', 'resize:120x32', 'input']);
  });

  it('does not cancel an owner resize for an ineligible claimant', async function () {
    const f = fixture({ coalesceMs: 20 });
    await f.coordinator.advertise('s1', 'desktop', 'main', 100, 30);
    await f.coordinator.advertise('s1', 'desktop', 'main', 120, 32);
    await f.coordinator.withDeliberateAction(
      's1',
      'unknown',
      'main',
      async () => {}
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepStrictEqual(f.resizes, [
      { cols: 100, rows: 30 },
      { cols: 120, rows: 32 },
    ]);
  });

  it('releases held output even when geometry broadcast throws', async function () {
    const order = [];
    const coordinator = new TerminalGeometryCoordinator({
      coalesceMs: 0,
      isActive: () => true,
      applyResize: async () => order.push('resize'),
      broadcast: () => {
        order.push('broadcast');
        throw new Error('socket write failed');
      },
      afterBroadcast: () => order.push('release'),
    });
    coordinator.initializeSession('s1', {});
    await assert.rejects(
      coordinator.advertise('s1', 'desktop', 'main', 100, 30),
      /socket write failed/
    );
    assert.deepStrictEqual(order, ['resize', 'broadcast', 'release']);
  });
});
