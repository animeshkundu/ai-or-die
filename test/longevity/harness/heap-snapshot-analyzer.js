'use strict';

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { redactSecrets } = require('../../../src/utils/secret-redact');

class JsonTokenStream {
  constructor(readable) {
    this._iterator = readable[Symbol.asyncIterator]();
    this._buffer = '';
    this._index = 0;
    this._done = false;
    this._decoder = new StringDecoder('utf8');
  }

  async _ensure() {
    while (this._index >= this._buffer.length && !this._done) {
      const next = await this._iterator.next();
      if (next.done) {
        this._done = true;
        this._buffer = this._decoder.end();
        this._index = 0;
        if (this._buffer.length > 0) break;
        continue;
      }
      this._buffer = this._decoder.write(next.value);
      this._index = 0;
    }
    return this._index < this._buffer.length;
  }

  async _readChar() {
    if (!(await this._ensure())) return null;
    return this._buffer[this._index++];
  }

  async next() {
    let char;
    do {
      char = await this._readChar();
    } while (char !== null && /\s/.test(char));
    if (char === null) return { type: 'eof' };
    if ('{}[]:,'.includes(char)) return { type: char };
    if (char === '"') return this._readString();
    if (char === '-' || /[0-9]/.test(char)) return this._readNumber(char);
    if (/[a-z]/i.test(char)) return this._readLiteral(char);
    throw new Error(`unexpected JSON character ${JSON.stringify(char)}`);
  }

  async _readString() {
    const raw = ['"'];
    let escaped = false;
    while (true) {
      const char = await this._readChar();
      if (char === null) throw new Error('unterminated JSON string');
      raw.push(char);
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }
    return { type: 'string', value: JSON.parse(raw.join('')) };
  }

  async _readNumber(first) {
    const chars = [first];
    while (await this._ensure()) {
      const char = this._buffer[this._index];
      if (!/[0-9eE+.-]/.test(char)) break;
      chars.push(char);
      this._index++;
    }
    const value = Number(chars.join(''));
    if (!Number.isFinite(value)) throw new Error(`invalid JSON number ${chars.join('')}`);
    return { type: 'number', value };
  }

  async _readLiteral(first) {
    const chars = [first];
    while (await this._ensure()) {
      const char = this._buffer[this._index];
      if (!/[a-z]/i.test(char)) break;
      chars.push(char);
      this._index++;
    }
    const literal = chars.join('');
    if (literal === 'true') return { type: 'boolean', value: true };
    if (literal === 'false') return { type: 'boolean', value: false };
    if (literal === 'null') return { type: 'null', value: null };
    throw new Error(`invalid JSON literal ${literal}`);
  }
}

async function expect(tokens, type) {
  const token = await tokens.next();
  if (token.type !== type) throw new Error(`expected ${type}, received ${token.type}`);
  return token;
}

async function readValue(tokens, firstToken) {
  const token = firstToken || await tokens.next();
  if (token.type === 'string' || token.type === 'number' ||
      token.type === 'boolean' || token.type === 'null') {
    return token.value;
  }
  if (token.type === '[') {
    const values = [];
    let next = await tokens.next();
    if (next.type === ']') return values;
    while (true) {
      values.push(await readValue(tokens, next));
      next = await tokens.next();
      if (next.type === ']') return values;
      if (next.type !== ',') throw new Error(`expected comma in array, received ${next.type}`);
      next = await tokens.next();
    }
  }
  if (token.type === '{') {
    const value = {};
    let next = await tokens.next();
    if (next.type === '}') return value;
    while (true) {
      if (next.type !== 'string') throw new Error(`expected object key, received ${next.type}`);
      const key = next.value;
      await expect(tokens, ':');
      value[key] = await readValue(tokens);
      next = await tokens.next();
      if (next.type === '}') return value;
      if (next.type !== ',') throw new Error(`expected comma in object, received ${next.type}`);
      next = await tokens.next();
    }
  }
  throw new Error(`cannot read JSON value from ${token.type}`);
}

async function skipValue(tokens, firstToken) {
  const token = firstToken || await tokens.next();
  if (!['[', '{'].includes(token.type)) return;
  const closing = token.type === '[' ? ']' : '}';
  const opening = token.type;
  let depth = 1;
  while (depth > 0) {
    const next = await tokens.next();
    if (next.type === 'eof') throw new Error('unexpected EOF while skipping JSON value');
    if (next.type === opening) depth++;
    else if (next.type === closing) depth--;
    else if (next.type === '[' && opening === '{') await skipValue(tokens, next);
    else if (next.type === '{' && opening === '[') await skipValue(tokens, next);
  }
}

async function readNumericArray(tokens, expectedLength) {
  await expect(tokens, '[');
  const target = Number.isFinite(expectedLength)
    ? new Float64Array(expectedLength)
    : [];
  let count = 0;
  let token = await tokens.next();
  if (token.type === ']') return target;
  while (true) {
    if (token.type !== 'number') throw new Error(`expected number, received ${token.type}`);
    if (Array.isArray(target)) target.push(token.value);
    else {
      if (count >= target.length) throw new Error('numeric array exceeds snapshot metadata length');
      target[count] = token.value;
    }
    count++;
    token = await tokens.next();
    if (token.type === ']') break;
    if (token.type !== ',') throw new Error(`expected comma, received ${token.type}`);
    token = await tokens.next();
  }
  if (!Array.isArray(target) && count !== target.length) {
    throw new Error(`numeric array length ${count} does not match expected ${target.length}`);
  }
  return Array.isArray(target) ? Float64Array.from(target) : target;
}

async function readStringArray(tokens) {
  await expect(tokens, '[');
  const values = [];
  let token = await tokens.next();
  if (token.type === ']') return values;
  while (true) {
    if (token.type !== 'string') throw new Error(`expected string, received ${token.type}`);
    values.push(token.value);
    token = await tokens.next();
    if (token.type === ']') return values;
    if (token.type !== ',') throw new Error(`expected comma, received ${token.type}`);
    token = await tokens.next();
  }
}

async function parseHeapSnapshot(file) {
  const tokens = new JsonTokenStream(fs.createReadStream(file, { highWaterMark: 256 * 1024 }));
  await expect(tokens, '{');
  const parsed = { snapshot: null, nodes: null, edges: null, strings: null };
  let token = await tokens.next();
  while (token.type !== '}') {
    if (token.type !== 'string') throw new Error(`expected top-level key, received ${token.type}`);
    const key = token.value;
    await expect(tokens, ':');
    if (key === 'snapshot') {
      parsed.snapshot = await readValue(tokens);
    } else if (key === 'nodes') {
      const fields = parsed.snapshot && parsed.snapshot.meta.node_fields;
      const length = parsed.snapshot && parsed.snapshot.node_count * fields.length;
      parsed.nodes = await readNumericArray(tokens, length);
    } else if (key === 'edges') {
      const fields = parsed.snapshot && parsed.snapshot.meta.edge_fields;
      const length = parsed.snapshot && parsed.snapshot.edge_count * fields.length;
      parsed.edges = await readNumericArray(tokens, length);
    } else if (key === 'strings') {
      parsed.strings = await readStringArray(tokens);
    } else {
      await skipValue(tokens);
    }
    token = await tokens.next();
    if (token.type === '}') break;
    if (token.type !== ',') throw new Error(`expected top-level comma, received ${token.type}`);
    token = await tokens.next();
  }
  if (!parsed.snapshot || !parsed.nodes || !parsed.edges || !parsed.strings) {
    throw new Error('snapshot is missing snapshot/nodes/edges/strings');
  }
  return parsed;
}

function buildGraph(parsed) {
  const meta = parsed.snapshot.meta;
  const nodeFields = meta.node_fields;
  const edgeFields = meta.edge_fields;
  const nodeWidth = nodeFields.length;
  const edgeWidth = edgeFields.length;
  const nodeCount = parsed.snapshot.node_count;
  const edgeCount = parsed.snapshot.edge_count;
  const nodeField = Object.fromEntries(nodeFields.map((name, index) => [name, index]));
  const edgeField = Object.fromEntries(edgeFields.map((name, index) => [name, index]));
  const nodeTypes = meta.node_types[nodeField.type];
  const edgeTypes = meta.edge_types[edgeField.type];
  const edgeStarts = new Uint32Array(nodeCount + 1);
  let edgeOrdinal = 0;
  for (let node = 0; node < nodeCount; node++) {
    edgeStarts[node] = edgeOrdinal;
    edgeOrdinal += parsed.nodes[node * nodeWidth + nodeField.edge_count];
  }
  edgeStarts[nodeCount] = edgeOrdinal;
  if (edgeOrdinal !== edgeCount) {
    throw new Error(`node edge counts total ${edgeOrdinal}, expected ${edgeCount}`);
  }
  return {
    ...parsed,
    nodeWidth,
    edgeWidth,
    nodeCount,
    edgeCount,
    nodeField,
    edgeField,
    nodeTypes,
    edgeTypes,
    edgeStarts,
  };
}

function edgeTarget(graph, edgeOrdinal) {
  const flat = graph.edges[edgeOrdinal * graph.edgeWidth + graph.edgeField.to_node];
  return flat / graph.nodeWidth;
}

function isRetainingEdge(graph, edgeOrdinal) {
  const typeIndex = graph.edges[edgeOrdinal * graph.edgeWidth + graph.edgeField.type];
  return graph.edgeTypes[typeIndex] !== 'weak';
}

function reversePostOrder(graph, root = 0) {
  const seen = new Uint8Array(graph.nodeCount);
  const postorder = [];
  const stack = [{ node: root, edge: graph.edgeStarts[root] }];
  seen[root] = 1;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    const end = graph.edgeStarts[frame.node + 1];
    let descended = false;
    while (frame.edge < end) {
      const edge = frame.edge++;
      if (!isRetainingEdge(graph, edge)) continue;
      const target = edgeTarget(graph, edge);
      if (seen[target]) continue;
      seen[target] = 1;
      stack.push({ node: target, edge: graph.edgeStarts[target] });
      descended = true;
      break;
    }
    if (!descended) {
      postorder.push(frame.node);
      stack.pop();
    }
  }
  postorder.reverse();
  return { order: Uint32Array.from(postorder), seen };
}

function buildPredecessors(graph, reachable) {
  const counts = new Uint32Array(graph.nodeCount);
  let retainingEdges = 0;
  for (let source = 0; source < graph.nodeCount; source++) {
    if (!reachable[source]) continue;
    for (let edge = graph.edgeStarts[source]; edge < graph.edgeStarts[source + 1]; edge++) {
      if (!isRetainingEdge(graph, edge)) continue;
      const target = edgeTarget(graph, edge);
      if (!reachable[target]) continue;
      counts[target]++;
      retainingEdges++;
    }
  }
  const offsets = new Uint32Array(graph.nodeCount + 1);
  for (let i = 0; i < graph.nodeCount; i++) offsets[i + 1] = offsets[i] + counts[i];
  const predecessors = new Uint32Array(retainingEdges);
  const cursor = offsets.slice(0, -1);
  for (let source = 0; source < graph.nodeCount; source++) {
    if (!reachable[source]) continue;
    for (let edge = graph.edgeStarts[source]; edge < graph.edgeStarts[source + 1]; edge++) {
      if (!isRetainingEdge(graph, edge)) continue;
      const target = edgeTarget(graph, edge);
      if (!reachable[target]) continue;
      predecessors[cursor[target]++] = source;
    }
  }
  return { offsets, predecessors };
}

function computeDominators(graph, root = 0) {
  const { order, seen } = reversePostOrder(graph, root);
  const rpoIndex = new Int32Array(graph.nodeCount);
  rpoIndex.fill(-1);
  for (let i = 0; i < order.length; i++) rpoIndex[order[i]] = i;
  const { offsets, predecessors } = buildPredecessors(graph, seen);
  const idom = new Int32Array(graph.nodeCount);
  idom.fill(-1);
  idom[root] = root;

  const intersect = (left, right) => {
    let a = left;
    let b = right;
    while (a !== b) {
      while (rpoIndex[a] > rpoIndex[b]) a = idom[a];
      while (rpoIndex[b] > rpoIndex[a]) b = idom[b];
    }
    return a;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < order.length; i++) {
      const node = order[i];
      let next = -1;
      for (let p = offsets[node]; p < offsets[node + 1]; p++) {
        const predecessor = predecessors[p];
        if (idom[predecessor] === -1) continue;
        next = next === -1 ? predecessor : intersect(predecessor, next);
      }
      if (next !== -1 && idom[node] !== next) {
        idom[node] = next;
        changed = true;
      }
    }
  }

  const retained = new Float64Array(graph.nodeCount);
  for (let node = 0; node < graph.nodeCount; node++) {
    retained[node] = graph.nodes[node * graph.nodeWidth + graph.nodeField.self_size];
  }
  for (let i = order.length - 1; i > 0; i--) {
    const node = order[i];
    if (idom[node] >= 0) retained[idom[node]] += retained[node];
  }
  return { idom, retained, reachable: seen, rpo: order };
}

function safeNodeName(type, value) {
  const name = String(value || '');
  if (type === 'string' || type === 'concatenated string' || type === 'sliced string') {
    return `<redacted-string bytes=${Buffer.byteLength(name, 'utf8')}>`;
  }
  if (type === 'symbol' || type === 'regexp') {
    return `<redacted-${type} bytes=${Buffer.byteLength(name, 'utf8')}>`;
  }
  if (type === 'code' && (path.isAbsolute(name) || /[\\/]/.test(name))) {
    return `<code:${path.basename(name)}>`;
  }
  return redactSecrets(name).slice(0, 200);
}

function describeNode(graph, node, retained, idom) {
  const base = node * graph.nodeWidth;
  const type = graph.nodeTypes[graph.nodes[base + graph.nodeField.type]];
  const name = safeNodeName(type, graph.strings[graph.nodes[base + graph.nodeField.name]]);
  const selfSize = graph.nodes[base + graph.nodeField.self_size];
  return {
    node,
    type,
    name,
    self_size: selfSize,
    retained_size: retained[node],
    immediate_dominator: idom[node],
  };
}

function pushTopRetainer(heap, node, retained, limit) {
  if (heap.length < limit) {
    heap.push(node);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (retained[heap[parent]] <= retained[heap[index]]) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
    return;
  }
  if (retained[node] <= retained[heap[0]]) return;
  heap[0] = node;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    let smallest = index;
    if (left < heap.length && retained[heap[left]] < retained[heap[smallest]]) smallest = left;
    if (right < heap.length && retained[heap[right]] < retained[heap[smallest]]) smallest = right;
    if (smallest === index) break;
    [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
    index = smallest;
  }
}

function analyzeParsedSnapshot(parsed, options = {}) {
  const graph = buildGraph(parsed);
  const dominators = computeDominators(graph);
  const limit = options.limit || 50;
  const top = [];
  for (let node = 0; node < graph.nodeCount; node++) {
    if (!dominators.reachable[node]) continue;
    pushTopRetainer(top, node, dominators.retained, limit);
  }

  top.sort((a, b) => dominators.retained[b] - dominators.retained[a]);
  const nodes = top.map((node) => {
    const described = describeNode(graph, node, dominators.retained, dominators.idom);
    const chain = [];
    let current = node;
    const visited = new Set();
    while (current >= 0 && !visited.has(current)) {
      visited.add(current);
      const entry = describeNode(graph, current, dominators.retained, dominators.idom);
      chain.push({ node: entry.node, type: entry.type, name: entry.name });
      if (dominators.idom[current] === current) break;
      current = dominators.idom[current];
    }
    described.retainer_chain = chain;
    return described;
  });

  let weakEdgesExcluded = 0;
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    if (!isRetainingEdge(graph, edge)) weakEdgesExcluded++;
  }

  return {
    node_count: graph.nodeCount,
    edge_count: graph.edgeCount,
    reachable_nodes: dominators.rpo.length,
    weak_edges_excluded: weakEdgesExcluded,
    top_retainers: nodes,
  };
}

async function analyzeHeapSnapshot(file, options = {}) {
  return analyzeParsedSnapshot(await parseHeapSnapshot(file), options);
}

module.exports = {
  JsonTokenStream,
  analyzeHeapSnapshot,
  analyzeParsedSnapshot,
  buildGraph,
  computeDominators,
  parseHeapSnapshot,
};
