import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

const tracePath = process.argv[2];
if (!tracePath) throw new Error('Usage: node scripts/analyze-chrome-trace.mjs <trace.json[.gz]>');

const input = createReadStream(tracePath);
const stream = tracePath.endsWith('.gz') ? input.pipe(createGunzip()) : input;
const threadNames = new Map();
const processNames = new Map();
const durationTotalsByThread = new Map();
const longTasks = [];
const frames = [];
const counters = [];
const heapSamples = [];
const profileNodes = new Map();
const profileSelfTime = new Map();
let eventCount = 0;
let inEvents = false;

function accept(event) {
  eventCount += 1;
  if (event.ph === 'M' && event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, event.args?.name ?? '');
  if (event.ph === 'M' && event.name === 'process_name') processNames.set(event.pid, event.args?.name ?? '');
  const threadKey = `${event.pid}:${event.tid}`;
  if (event.name === 'ProfileChunk') {
    const profileKey = `${threadKey}:${event.id}`;
    const nodes = profileNodes.get(profileKey) ?? new Map();
    for (const node of event.args?.data?.cpuProfile?.nodes ?? []) nodes.set(node.id, node.callFrame);
    profileNodes.set(profileKey, nodes);
    const samples = event.args?.data?.cpuProfile?.samples ?? [];
    const deltas = event.args?.data?.timeDeltas ?? [];
    for (let index = 0; index < samples.length; index += 1) {
      const key = `${profileKey}\u0000${samples[index]}`;
      profileSelfTime.set(key, (profileSelfTime.get(key) ?? 0) + (deltas[index] ?? 0));
    }
  }
  if (event.ph === 'X') {
    const statKey = `${threadKey}\u0000${event.name}`;
    const current = durationTotalsByThread.get(statKey) ?? { total: 0, count: 0, max: 0 };
    const duration = event.dur ?? 0;
    current.total += duration;
    current.count += 1;
    current.max = Math.max(current.max, duration);
    durationTotalsByThread.set(statKey, current);
    if (duration >= 16_667 && threadNames.get(threadKey) === 'CrRendererMain') {
      longTasks.push(event);
      longTasks.sort((left, right) => (right.dur ?? 0) - (left.dur ?? 0));
      if (longTasks.length > 80) longTasks.length = 80;
    }
  }
  if (threadNames.get(threadKey) === 'CrRendererMain' && event.name === 'PageAnimator::serviceScriptedAnimations') {
    frames.push(event.ts);
  }
  if (event.name === 'UpdateCounters' && Number.isFinite(event.args?.data?.jsHeapSizeUsed)) {
    heapSamples.push({ timestamp: event.ts, bytes: event.args.data.jsHeapSizeUsed });
  }
  if ((event.ph === 'C' && /memory|counter|heap/i.test(event.name)) || event.name === 'UpdateCounters') {
    counters.push(event);
    if (counters.length > 20) counters.shift();
  }
}

const lines = createInterface({ input: stream, crlfDelay: Infinity });
for await (const line of lines) {
  if (!inEvents) {
    if (line.includes('"traceEvents"')) inEvents = true;
    continue;
  }
  const trimmed = line.trim();
  if (trimmed === ']' || trimmed === '],') break;
  if (!trimmed.startsWith('{') || trimmed.length > 2_000_000) continue;
  const objectText = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
  accept(JSON.parse(objectText));
}

const mainThreads = new Set([...threadNames].filter(([, name]) => name === 'CrRendererMain').map(([key]) => key));
const workerThreads = new Set([...threadNames].filter(([, name]) => /Worker|ThreadPool/.test(name)).map(([key]) => key));
const durationTotals = new Map();
for (const [key, value] of durationTotalsByThread) {
  const [threadKey, name] = key.split('\u0000');
  const group = `${mainThreads.has(threadKey) ? 'main' : workerThreads.has(threadKey) ? 'worker' : 'other'} | ${name}`;
  const current = durationTotals.get(group) ?? { total: 0, count: 0, max: 0 };
  current.total += value.total;
  current.count += value.count;
  current.max = Math.max(current.max, value.max);
  durationTotals.set(group, current);
}

const topDurations = [...durationTotals].sort((a, b) => b[1].total - a[1].total).slice(0, 80)
  .map(([name, value]) => ({ name, totalMs: +(value.total / 1000).toFixed(2), count: value.count, maxMs: +(value.max / 1000).toFixed(2) }));
const topLongTasks = longTasks.sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0)).slice(0, 80).map(event => ({
  name: event.name,
  durationMs: +((event.dur ?? 0) / 1000).toFixed(2),
  timestampMs: +(event.ts / 1000).toFixed(2),
  data: event.args?.data ?? event.args,
}));
const frameGaps = frames.sort((a, b) => a - b).slice(1).map((timestamp, index) => timestamp - frames[index]);
const cpuTotals = new Map();
for (const [key, duration] of profileSelfTime) {
  const separator = key.lastIndexOf('\u0000');
  const profileKey = key.slice(0, separator);
  const nodeId = Number(key.slice(separator + 1));
  const frame = profileNodes.get(profileKey)?.get(nodeId);
  if (!frame) continue;
  const threadKey = profileKey.slice(0, profileKey.lastIndexOf(':'));
  const group = mainThreads.has(threadKey) ? 'main' : workerThreads.has(threadKey) ? 'worker' : 'other';
  const label = `${group} | ${frame.functionName || '(anonymous)'} | ${frame.url || frame.scriptId || frame.codeType}`;
  cpuTotals.set(label, (cpuTotals.get(label) ?? 0) + duration);
}
const summary = {
  processes: Object.fromEntries(processNames),
  threads: Object.fromEntries(threadNames),
  eventCount,
  frameGaps: frameGaps.length ? {
    count: frameGaps.length,
    over16ms: frameGaps.filter(value => value > 16_667).length,
    over33ms: frameGaps.filter(value => value > 33_334).length,
    p50Ms: +(frameGaps.sort((a, b) => a - b)[Math.floor(frameGaps.length * 0.5)] / 1000).toFixed(2),
    p95Ms: +(frameGaps[Math.floor(frameGaps.length * 0.95)] / 1000).toFixed(2),
    maxMs: +(Math.max(...frameGaps) / 1000).toFixed(2),
  } : null,
  jsHeap: heapSamples.length ? {
    samples: heapSamples.length,
    firstMiB: +(heapSamples[0].bytes / 1048576).toFixed(2),
    lastMiB: +(heapSamples.at(-1).bytes / 1048576).toFixed(2),
    minMiB: +(Math.min(...heapSamples.map(sample => sample.bytes)) / 1048576).toFixed(2),
    maxMiB: +(Math.max(...heapSamples.map(sample => sample.bytes)) / 1048576).toFixed(2),
  } : null,
  topDurations,
  topCpuSelfTime: [...cpuTotals].sort((a, b) => b[1] - a[1]).slice(0, 80)
    .map(([name, duration]) => ({ name, selfMs: +(duration / 1000).toFixed(2) })),
  topLongTasks,
  counters,
};
console.log(JSON.stringify(summary, null, 2));
