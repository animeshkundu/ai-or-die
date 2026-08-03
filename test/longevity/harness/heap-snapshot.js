'use strict';

const fs = require('fs');
const path = require('path');
const v8 = require('v8');

function captureHeapSnapshot(outputDir, label) {
  const file = path.join(outputDir, `heap-${label}.heapsnapshot`);
  return v8.writeHeapSnapshot(file);
}

function nodeGroup(snapshot, nodeOffset) {
  const meta = snapshot.snapshot.meta;
  const fields = meta.node_fields;
  const nodes = snapshot.nodes;
  const typeIndex = fields.indexOf('type');
  const nameIndex = fields.indexOf('name');
  const type = meta.node_types[typeIndex][nodes[nodeOffset + typeIndex]];
  const name = snapshot.strings[nodes[nodeOffset + nameIndex]] || '';

  if (type === 'object' || type === 'closure' || type === 'regexp') {
    return `${type}:${name || '(anonymous)'}`;
  }
  return type;
}

function summarizeHeapSnapshot(file) {
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  const meta = snapshot.snapshot.meta;
  const nodeFields = meta.node_fields;
  const selfSizeIndex = nodeFields.indexOf('self_size');
  const nodeWidth = nodeFields.length;
  const groups = new Map();

  for (let offset = 0; offset < snapshot.nodes.length; offset += nodeWidth) {
    const name = nodeGroup(snapshot, offset);
    const group = groups.get(name) || { count: 0, self_size: 0 };
    group.count++;
    group.self_size += snapshot.nodes[offset + selfSizeIndex];
    groups.set(name, group);
  }
  return { snapshot, groups };
}

function edgeName(snapshot, edgeOffset) {
  const meta = snapshot.snapshot.meta;
  const edgeFields = meta.edge_fields;
  const edgeTypes = meta.edge_types;
  const typeIndex = edgeFields.indexOf('type');
  const nameIndex = edgeFields.indexOf('name_or_index');
  const type = edgeTypes[typeIndex][snapshot.edges[edgeOffset + typeIndex]];
  const raw = snapshot.edges[edgeOffset + nameIndex];
  return type === 'element' || type === 'hidden' ? String(raw) : (snapshot.strings[raw] || type);
}

function edgeType(snapshot, edgeOffset) {
  const meta = snapshot.snapshot.meta;
  const typeIndex = meta.edge_fields.indexOf('type');
  return meta.edge_types[typeIndex][snapshot.edges[edgeOffset + typeIndex]];
}

function findRetainerPath(snapshot, groupName, options = {}) {
  if (typeof options === 'number') options = { maxVisited: options };
  const maxVisited = options.maxVisited || 500000;
  const requiredVias = options.requiredVias || [];
  const meta = snapshot.snapshot.meta;
  const nodeFields = meta.node_fields;
  const edgeFields = meta.edge_fields;
  const edgeCountIndex = nodeFields.indexOf('edge_count');
  const edgeToIndex = edgeFields.indexOf('to_node');
  const nodeWidth = nodeFields.length;
  const edgeWidth = edgeFields.length;
  const nodeCount = snapshot.nodes.length / nodeWidth;
  const edgeOffsets = new Uint32Array(nodeCount);
  let cursor = 0;

  for (let index = 0; index < nodeCount; index++) {
    edgeOffsets[index] = cursor;
    cursor += snapshot.nodes[index * nodeWidth + edgeCountIndex] * edgeWidth;
  }

  const parents = new Int32Array(nodeCount);
  parents.fill(-2);
  const parentEdges = new Array(nodeCount);
  const queue = new Uint32Array(nodeCount);
  let read = 0;
  let write = 1;
  queue[0] = 0;
  parents[0] = -1;
  let target = -1;

  while (read < write && read < maxVisited) {
    const current = queue[read++];
    if (current !== 0 && nodeGroup(snapshot, current * nodeWidth) === groupName) {
      const vias = [];
      for (let ancestor = current; ancestor !== -1; ancestor = parents[ancestor]) {
        vias.push(parentEdges[ancestor]);
      }
      if (requiredVias.every((via) => vias.includes(via))) {
        target = current;
        break;
      }
    }
    const edgeStart = edgeOffsets[current];
    const edgeCount = snapshot.nodes[current * nodeWidth + edgeCountIndex];
    for (let index = 0; index < edgeCount; index++) {
      const edgeOffset = edgeStart + index * edgeWidth;
      if (edgeType(snapshot, edgeOffset) === 'weak') continue;
      const child = snapshot.edges[edgeOffset + edgeToIndex] / nodeWidth;
      if (parents[child] !== -2) continue;
      parents[child] = current;
      parentEdges[child] = edgeName(snapshot, edgeOffset);
      queue[write++] = child;
    }
  }

  if (target === -1) return null;
  const pathParts = [];
  for (let current = target; current !== -1; current = parents[current]) {
    pathParts.push({
      group: nodeGroup(snapshot, current * nodeWidth),
      via: parentEdges[current] || null,
    });
  }
  return pathParts.reverse();
}

function diffHeapSnapshots(beforeFile, afterFile, options = {}) {
  const before = summarizeHeapSnapshot(beforeFile);
  const after = summarizeHeapSnapshot(afterFile);
  const groups = new Set([...before.groups.keys(), ...after.groups.keys()]);
  const changes = [];

  for (const group of groups) {
    const oldValue = before.groups.get(group) || { count: 0, self_size: 0 };
    const newValue = after.groups.get(group) || { count: 0, self_size: 0 };
    const selfSizeDelta = newValue.self_size - oldValue.self_size;
    const countDelta = newValue.count - oldValue.count;
    if (selfSizeDelta > 0 || countDelta > 0) {
      changes.push({
        group,
        count_delta: countDelta,
        self_size_delta: selfSizeDelta,
      });
    }
  }

  changes.sort((a, b) => b.self_size_delta - a.self_size_delta || b.count_delta - a.count_delta);
  const top = changes.slice(0, options.top || 25).map((change) => ({
    ...change,
    retainer_path: findRetainerPath(after.snapshot, change.group),
    retainer_path_kind: 'representative_strong_path',
  }));
  return {
    before: path.basename(beforeFile),
    after: path.basename(afterFile),
    top,
  };
}

module.exports = {
  captureHeapSnapshot,
  diffHeapSnapshots,
  findRetainerPath,
  summarizeHeapSnapshot,
};
