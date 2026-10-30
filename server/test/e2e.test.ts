import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, strToU8, zipSync } from 'fflate';
import { DEFAULT_DEDICATED_MODEL, type StreamEvent } from '@open-rock/shared';
import { BEDROCK_KEY, DEDICATED_TOKEN, startBedrockMock, startGemmaMock, type BedrockMock, type GemmaMock } from './mocks.js';

let gemma: GemmaMock;
let gemmaPlain: GemmaMock;
let gemmaOtherName: GemmaMock;
let bedrock: BedrockMock;
let app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
const H = { 'x-open-rock-client': 'test', 'Content-Type': 'application/json' };

before(async () => {
  gemma = await startGemmaMock({ tls: true });
  gemmaPlain = await startGemmaMock();
  gemmaOtherName = await startGemmaMock({ tls: 'othername' });
  bedrock = await startBedrockMock();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-rock-test-'));
  process.env.OPEN_ROCK_DATA_DIR = dataDir;
  process.env.OPEN_ROCK_DEDICATED_HOST = '127.0.0.1';
  process.env.OPEN_ROCK_DEDICATED_TOKEN = DEDICATED_TOKEN;
  process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = bedrock.runtimeUrl;
  process.env.AWS_ENDPOINT_URL_BEDROCK = bedrock.controlUrl;
  delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  const mod = await import('../src/app.js');
  app = mod.createApp();
  // The mock Gemma server uses HTTPS with a self-signed certificate on a random port.
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ dedicated: { servers: [{ ...SERVER, port: gemma.port }] } }) });
});

after(async () => {
  await gemma.close();
  await gemmaPlain.close();
  await gemmaOtherName.close();
  await bedrock.close();
});

async function json(p: string, init?: RequestInit) {
  const res = await app.request(p, { ...init, headers: { ...H, ...(init?.headers as object) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const SERVER = { id: 'gemma', name: 'Gemma', host: '127.0.0.1', port: 443, apiKey: '', authHeader: 'auto', apiStyle: 'auto', model: '' };

/**
 * Change the first dedicated server (the one chats use when none is picked) the way the Settings page does: send the
 * whole list back, saved tokens still masked. `shared` holds dedicated settings for every server (the system prompt).
 */
async function setServer(patch: Record<string, unknown>, shared: Record<string, unknown> = {}) {
  const [first, ...rest] = (await json('/api/settings')).body.settings.dedicated.servers;
  return json('/api/settings', { method: 'PUT', body: JSON.stringify({ dedicated: { ...shared, servers: [{ ...first, ...patch }, ...rest] } }) });
}

async function sse(p: string, body: unknown): Promise<StreamEvent[]> {
  const res = await app.request(p, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const text = await res.text();
  return text
    .split('\n\n')
    // After our own error event, Hono repeats a thrown error as a plain-text "event: error"; the client skips it too.
    .filter((chunk) => !chunk.startsWith('event: error'))
    .map((chunk) => chunk.split('\n').find((l) => l.startsWith('data:')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(5)) as StreamEvent);
}

function textOf(events: StreamEvent[]) {
  return events.filter((e): e is Extract<StreamEvent, { type: 'delta' }> => e.type === 'delta').map((e) => e.text).join('');
}

test('rejects calls without the client header', async () => {
  const res = await app.request('/api/settings');
  assert.equal(res.status, 400);
  const health = await app.request('/api/health');
  assert.equal(health.status, 200);
});

test('settings never expose the API key or the Gemma endpoint token', async () => {
  const put = await json('/api/settings', { method: 'PUT', body: JSON.stringify({ aws: { bedrockApiKey: BEDROCK_KEY, region: 'us-east-1' } }) });
  assert.equal(put.status, 200);
  assert.equal(put.body.settings.aws.bedrockApiKey, '••••••••');
  assert.ok(!JSON.stringify(put.body).includes(BEDROCK_KEY));
  assert.ok(!JSON.stringify(put.body).includes(DEDICATED_TOKEN));
  assert.equal(put.body.info.dedicatedEnvTokenHost, '127.0.0.1');
  // Sending the mask back keeps the stored key.
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ aws: { bedrockApiKey: '••••••••' } }) });
  const fileSettings = JSON.parse(fs.readFileSync(path.join(process.env.OPEN_ROCK_DATA_DIR!, 'settings.json'), 'utf8'));
  assert.equal(fileSettings.aws.bedrockApiKey, BEDROCK_KEY);
});

test('lists Bedrock chat models with inference profiles, using the API key as a bearer token', async () => {
  const { status, body } = await json('/api/models?mode=bedrock&refresh=1');
  assert.equal(status, 200, JSON.stringify(body));
  const ids = body.models.map((m: { id: string }) => m.id);
  assert.ok(ids.includes('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), ids.join(','));
  assert.ok(ids.includes('amazon.nova-micro-v1:0'));
  assert.ok(!ids.some((i: string) => i.includes('rerank')), 'rerank filtered');
  assert.ok(!ids.some((i: string) => i.endsWith(':28k')), 'provisioned-only filtered');
  const sonnet = body.models.find((m: { baseId: string }) => m.baseId.startsWith('anthropic.claude-sonnet-4-5'));
  assert.equal(sonnet.capabilities.images, true);
  assert.equal(sonnet.capabilities.documents, true);
  assert.equal(sonnet.capabilities.reasoning, true);
  assert.ok(bedrock.controlAuth.every((a) => a === `Bearer ${BEDROCK_KEY}`));

  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { crossRegion: 'global' } }) });
  const g = await json('/api/models?mode=bedrock');
  assert.ok(g.body.models.some((m: { id: string }) => m.id === 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'));
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { crossRegion: 'auto' } }) });
});

test('lists every model Bedrock can run: legacy ones like Gemma 3, and the ones you set up yourself', async () => {
  const { body } = await json('/api/models?mode=bedrock&refresh=1');
  const byId = new Map<string, { name: string; provider: string; legacy?: boolean; endOfLife?: number; capabilities: { images: boolean; reasoning: boolean } }>(
    body.models.map((m: { id: string }) => [m.id, m]),
  );
  const gemma = byId.get('google.gemma-3-12b-it');
  assert.ok(gemma, [...byId.keys()].join(','));
  assert.equal(gemma.legacy, true);
  assert.equal(gemma.endOfLife, Date.UTC(2027, 2, 30));
  assert.equal(gemma.capabilities.images, true);
  assert.equal(byId.get('openai.gpt-oss-120b-1:0')?.capabilities.reasoning, true);
  assert.equal(byId.get('anthropic.claude-opus-5-5')?.capabilities.reasoning, true);

  // Provisioned throughput makes the ":28k" model usable, under the provisioned model's ARN.
  assert.equal(byId.get('arn:aws:bedrock:us-east-1:123:provisioned-model/pt-sonnet')?.provider, 'Provisioned throughput');
  assert.equal(byId.get('arn:aws:bedrock:us-east-1:123:custom-model-deployment/dep1')?.name, 'Tuned Nova');
  assert.ok(!byId.has('arn:aws:bedrock:us-east-1:123:custom-model-deployment/dep2'), 'failed deployment left out');
  assert.equal(byId.get('arn:aws:bedrock:us-east-1:123:imported-model/llama-ft')?.provider, 'Imported models');
  assert.ok(!byId.has('arn:aws:bedrock:us-east-1:123:imported-model/qwen-ft'), 'Converse cannot run imported Qwen');
  const market = byId.get('arn:aws:sagemaker:us-east-1:123:endpoint/gemma-3-27b');
  assert.equal(market?.provider, 'Marketplace');
  assert.equal(market?.name, 'huggingface-vlm-gemma-3-27b-instruct (gemma-3-27b)');
});

test('knows which settings each Bedrock model takes', async () => {
  const { bedrockModelParams: p } = await import('@open-rock/shared');
  const pick = (id: string) => {
    const x = p(id);
    return [x.thinking, x.maxOutputTokens, x.temperature, x.topK, x.effortLevels.length, x.thinkingOnByDefault, x.maxEffortWithoutThinking];
  };
  assert.deepEqual(pick('anthropic.claude-3-5-haiku-20241022-v1:0'), [null, 8192, true, true, 0, false, null]);
  assert.deepEqual(pick('anthropic.claude-3-7-sonnet-20250219-v1:0'), ['budget', 64000, true, true, 0, false, null]);
  assert.deepEqual(pick('anthropic.claude-sonnet-4-20250514-v1:0'), ['budget', 64000, true, true, 0, false, null]);
  assert.deepEqual(pick('anthropic.claude-opus-4-1-20250805-v1:0'), ['budget', 32000, true, true, 0, false, null]);
  assert.deepEqual(pick('us.anthropic.claude-haiku-4-5-20251001-v1:0'), ['budget', 64000, true, true, 0, false, null]);
  assert.deepEqual(pick('global.anthropic.claude-opus-4-6-v1'), ['adaptive', 128000, true, true, 4, false, null]);
  assert.deepEqual(pick('anthropic.claude-opus-4-7'), ['adaptive', 128000, false, false, 5, false, null]);
  assert.deepEqual(pick('anthropic.claude-sonnet-5'), ['adaptive', 128000, false, false, 5, true, null]);
  assert.deepEqual(pick('anthropic.claude-opus-5'), ['adaptive', 128000, false, false, 5, true, 'high']);
  assert.deepEqual(pick('anthropic.claude-haiku-5-5'), ['adaptive', 128000, false, false, 5, true, 'high']);
  for (const id of ['anthropic.claude-opus-5-5', 'anthropic.claude-sonnet-5-5', 'anthropic.claude-fable-5-1']) {
    assert.deepEqual(pick(id), ['always', 128000, false, false, 5, false, null], id);
  }
  assert.deepEqual(pick('google.gemma-3-27b-it'), [null, 8192, true, false, 0, false, null]);
  assert.deepEqual(pick('openai.gpt-oss-20b-1:0'), ['effort', null, true, false, 3, false, null]);
  assert.deepEqual(pick('deepseek.r1-v1:0'), ['builtin', null, true, false, 0, false, null]);
  assert.equal(p('amazon.nova-pro-v1:0').topK, true);
  assert.deepEqual(pick('acme.unknown-v1'), [null, null, true, false, 0, false, null]);
});

test('streams a Bedrock reply, records usage and attaches a PDF natively', async () => {
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'bedrock' }) })).body;
  // Minimal file upload
  const form = new FormData();
  form.append('file', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'Q3 report_final.pdf', { type: 'application/pdf' }));
  const up = await app.request('/api/files', { method: 'POST', headers: { 'x-open-rock-client': 'test' }, body: form });
  assert.equal(up.status, 201);
  const file = (await up.json()) as { id: string; kind: string };
  assert.equal(file.kind, 'document');

  const events = await sse(`/api/conversations/${conv.id}/messages`, {
    content: 'Summarize this',
    attachmentIds: [file.id],
    mode: 'bedrock',
    modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  });
  assert.equal(events[0].type, 'start');
  assert.equal(textOf(events), 'Hello from Bedrock');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done', JSON.stringify(events));
  assert.equal(done.message.usage?.inputTokens, 120);
  assert.equal(done.message.usage?.cacheReadTokens, 10);

  const req = bedrock.runtimeRequests.at(-1)!;
  assert.equal(req.auth, `Bearer ${BEDROCK_KEY}`);
  assert.equal(req.modelId, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  const blocks = req.body.messages[0].content;
  assert.equal(blocks[0].document.format, 'pdf');
  assert.equal(blocks[0].document.name, 'Q3 report final');
  assert.equal(blocks.at(-1).text, 'Summarize this');
  // Max output left unset: the model's own maximum.
  assert.equal(req.body.inferenceConfig.maxTokens, undefined);

  const usage = await json('/api/usage?range=7d&tz=0');
  assert.equal(usage.body.totals.requests, 1);
  const row = usage.body.models[0];
  assert.equal(row.inputTokens, 120);
  // Starter price for Sonnet 4: $3 in / $15 out / $0.30 cache read per 1M
  assert.ok(Math.abs(row.cost - (120 * 3 + 3 * 15 + 10 * 0.3) / 1e6) < 1e-12, String(row.cost));
  const bucketTotal = usage.body.buckets.reduce((a: number, b: { tokens: Record<string, number> }) => a + Object.values(b.tokens).reduce((x, y) => x + y, 0), 0);
  assert.equal(bucketTotal, 133);
});

test('extended thinking streams reasoning and drops temperature', async () => {
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { replies: { thinking: 'on', budgetTokens: 2000, temperature: 0.5, maxTokens: 1000 } } }) });
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'bedrock' }) })).body;
  const events = await sse(`/api/conversations/${conv.id}/messages`, { content: 'Think', attachmentIds: [], mode: 'bedrock', modelId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0' });
  assert.ok(events.some((e) => e.type === 'reasoning'));
  const req = bedrock.runtimeRequests.at(-1)!;
  assert.equal(req.body.additionalModelRequestFields.thinking.budget_tokens, 2000);
  assert.equal(req.body.inferenceConfig.temperature, undefined);
  // The budget has to fit inside max_tokens with room for the answer.
  assert.equal(req.body.inferenceConfig.maxTokens, 2000 + 2048);
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { replies: { thinking: 'default', temperature: null, maxTokens: null } } }) });
});

test('retries without a system prompt for models that reject it', async () => {
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { systemPrompt: 'Be brief.' } }) });
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'bedrock' }) })).body;
  // Mistral 7B is flagged as no-system up front, so the first request already merges it.
  const events = await sse(`/api/conversations/${conv.id}/messages`, { content: 'Hi', attachmentIds: [], mode: 'bedrock', modelId: 'mistral.mistral-7b-instruct-v0:2' });
  assert.equal(textOf(events), 'Hello from Bedrock');
  const req = bedrock.runtimeRequests.at(-1)!;
  assert.equal(req.body.system, undefined);
  assert.match(req.body.messages[0].content.at(-1).text, /^Be brief\.\n\nHi$/);

  // A custom model we know nothing about: first attempt sends a system prompt, Bedrock rejects it, we retry.
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { customModels: [{ id: 'acme.nosys-v1', name: 'Acme', images: false, documents: false, video: false }] } }) });
  const before = bedrock.runtimeRequests.length;
  const ev2 = await sse(`/api/conversations/${conv.id}/messages`, { content: 'Again', attachmentIds: [], mode: 'bedrock', modelId: 'acme.nosys-v1' });
  assert.equal(textOf(ev2), 'Hello from Bedrock', JSON.stringify(ev2));
  const tries = bedrock.runtimeRequests.slice(before);
  assert.equal(tries.length, 2);
  assert.ok(tries[0].body.system);
  assert.equal(tries[1].body.system, undefined);
  assert.ok(ev2.some((e) => e.type === 'notice' && /system prompt/.test(e.message)));
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { customModels: [] } }) });
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { systemPrompt: '' } }) });
});

test('each Bedrock model is sent only the settings it takes, within its limits', async () => {
  await json('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ bedrock: { replies: { temperature: 0.4, topP: 0.9, topK: 20, maxTokens: 100000, effort: 'xhigh', thinking: 'on' } } }),
  });
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'bedrock' }) })).body;
  const ask = async (modelId: string) => {
    const events = await sse(`/api/conversations/${conv.id}/messages`, { content: 'Hi', attachmentIds: [], mode: 'bedrock', modelId });
    assert.equal(textOf(events), 'Hello from Bedrock', JSON.stringify(events));
    return bedrock.runtimeRequests.at(-1)!.body;
  };

  // Claude Opus 4.7: adaptive thinking and effort, no sampling settings.
  let body = await ask('anthropic.claude-opus-4-7');
  assert.deepEqual(body.additionalModelRequestFields, { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'xhigh' } });
  assert.deepEqual(body.inferenceConfig, { maxTokens: 100000 });

  // Claude Opus 5.5 always thinks; it gets effort and nothing to turn thinking on or off besides adaptive.
  body = await ask('anthropic.claude-opus-5-5');
  assert.equal(body.additionalModelRequestFields.thinking.type, 'adaptive');
  assert.equal(body.additionalModelRequestFields.output_config.effort, 'xhigh');
  assert.equal(body.inferenceConfig.temperature, undefined);

  // Gemma 3: sampling settings go through, max output is capped at 8K, and there's nothing model-specific to add.
  body = await ask('google.gemma-3-12b-it');
  assert.deepEqual(body.inferenceConfig, { maxTokens: 8192, temperature: 0.4, topP: 0.9 });
  assert.equal(body.additionalModelRequestFields, undefined);

  // gpt-oss takes reasoning effort, but only up to high.
  body = await ask('openai.gpt-oss-120b-1:0');
  assert.equal(body.additionalModelRequestFields, undefined, 'xhigh is not a gpt-oss level');
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { replies: { effort: 'low' } } }) });
  body = await ask('openai.gpt-oss-120b-1:0');
  assert.deepEqual(body.additionalModelRequestFields, { reasoning_effort: 'low' });

  // Nova takes Top K in its own field.
  body = await ask('amazon.nova-micro-v1:0');
  assert.deepEqual(body.additionalModelRequestFields, { inferenceConfig: { topK: 20 } });

  // Claude Sonnet 4.5 with thinking on: a budget, and sampling settings left out.
  body = await ask('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
  assert.equal(body.additionalModelRequestFields.thinking.type, 'enabled');
  assert.equal(body.inferenceConfig.temperature, undefined);
  assert.equal(body.inferenceConfig.maxTokens, 64000);

  // A model's own settings replace the ones for all models, for that model only.
  const own = { maxTokens: 500, temperature: 0.1, topP: null, topK: null, stopSequences: [], thinking: 'off', budgetTokens: 4096, effort: null };
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { modelReplies: { 'google.gemma-3-12b-it': own } } }) });
  body = await ask('google.gemma-3-12b-it');
  assert.deepEqual(body.inferenceConfig, { maxTokens: 500, temperature: 0.1 });
  body = await ask('amazon.nova-micro-v1:0');
  assert.equal(body.inferenceConfig.temperature, 0.4);

  await json('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ bedrock: { modelReplies: {}, replies: { temperature: null, topP: null, topK: null, maxTokens: null, effort: null, thinking: 'default' } } }),
  });
});

test('thinking follows each model unless you choose, and "off" turns it off', async () => {
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'bedrock' }) })).body;
  const ask = async (modelId: string) => {
    await sse(`/api/conversations/${conv.id}/messages`, { content: 'Hi', attachmentIds: [], mode: 'bedrock', modelId });
    return bedrock.runtimeRequests.at(-1)!.body.additionalModelRequestFields;
  };
  // Model's default: Sonnet 5 thinks (asked for explicitly, to get a readable summary); Opus 4.7 and Sonnet 4.5 don't.
  assert.deepEqual(await ask('anthropic.claude-sonnet-5'), { thinking: { type: 'adaptive', display: 'summarized' } });
  assert.equal(await ask('anthropic.claude-opus-4-7'), undefined);
  assert.equal(await ask('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), undefined);

  // Off: models that think by default are told not to; Opus 5 then takes effort only up to high.
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { replies: { thinking: 'off', effort: 'max' } } }) });
  assert.deepEqual(await ask('anthropic.claude-sonnet-5'), { thinking: { type: 'disabled' }, output_config: { effort: 'max' } });
  assert.deepEqual(await ask('anthropic.claude-opus-5'), { thinking: { type: 'disabled' }, output_config: { effort: 'high' } });
  assert.deepEqual(await ask('anthropic.claude-opus-4-7'), { output_config: { effort: 'max' } });

  // Settings saved before "model's default" existed: false was the untouched default, true meant on.
  const { fromStored } = await import('../src/settings.js');
  const old = fromStored({ bedrock: { replies: { thinking: false }, modelReplies: { 'anthropic.claude-sonnet-5': { thinking: false }, x: { thinking: true } } } });
  assert.equal(old.bedrock.replies.thinking, 'default');
  assert.equal(old.bedrock.modelReplies['anthropic.claude-sonnet-5'].thinking, 'default');
  assert.equal(old.bedrock.modelReplies.x.thinking, 'on');

  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { replies: { thinking: 'default', effort: null } } }) });
});

test('model list survives missing list permissions', async () => {
  bedrock.deny.profiles = true;
  const a = await json('/api/models?mode=bedrock&refresh=1');
  assert.ok(a.body.models.some((m: { id: string }) => m.id === 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'falls back to the geographic profile ID');
  bedrock.deny.profiles = false;
  bedrock.deny.models = true;
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { customModels: [{ id: 'arn:aws:bedrock:us-east-1:123:provisioned-model/abc', name: 'Mine', images: true, documents: false, video: false }] } }) });
  const b = await json('/api/models?mode=bedrock&refresh=1');
  assert.equal(b.status, 200);
  assert.match(b.body.error, /Access denied/);
  assert.deepEqual(b.body.models.map((m: { name: string }) => m.name), ['Mine']);
  bedrock.deny.models = false;
  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ bedrock: { customModels: [] } }) });
  await json('/api/models?mode=bedrock&refresh=1');
});

test('reports Gemma server status with detected protocol and context size', async () => {
  const st = await json('/api/dedicated/status');
  assert.equal(st.body.ok, true, st.body.message);
  assert.equal(st.body.apiStyle, 'openai');
  assert.equal(st.body.contextSize, 32768);
  assert.deepEqual(st.body.models, ['google/gemma-3-27b-it']);
  assert.ok(!JSON.stringify(st.body).includes(DEDICATED_TOKEN));
});

test('dedicated chat sends the bearer token, sampling options and images (OpenAI-compatible)', async () => {
  await setServer({ topK: 40, minP: 0.05, seed: 7, stop: ['<end>'] }, { systemPrompt: 'You are Gemma.' });
  const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const form = new FormData();
  form.append('file', new File([png], 'dot.png', { type: 'image/png' }));
  const img = (await (await app.request('/api/files', { method: 'POST', headers: { 'x-open-rock-client': 'test' }, body: form })).json()) as { id: string };
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  const events = await sse(`/api/conversations/${conv.id}/messages`, { content: 'What is this?', attachmentIds: [img.id], mode: 'dedicated', modelId: '' });
  assert.equal(textOf(events), 'Hello from Gemma', JSON.stringify(events));
  const done = events.find((e) => e.type === 'done');
  assert.ok(done && done.type === 'done');
  assert.equal(done.message.usage?.inputTokens, 57);
  assert.equal(done.message.context?.estimated, false);

  const req = gemma.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)!;
  assert.equal(req.auth, `Bearer ${DEDICATED_TOKEN}`);
  assert.equal(req.body.model, 'google/gemma-3-27b-it');
  assert.equal(req.body.messages[0].role, 'system');
  assert.equal(req.body.max_tokens, 1024);
  assert.equal(req.body.top_k, 40);
  // Sampling left blank is left to the model.
  assert.equal(req.body.temperature, undefined);
  assert.equal(req.body.min_p, 0.05);
  assert.equal(req.body.seed, 7);
  assert.deepEqual(req.body.stop, ['<end>']);
  assert.deepEqual(req.body.stream_options, { include_usage: true });
  const parts = req.body.messages[1].content;
  assert.equal(parts[0].type, 'image_url');
  assert.match(parts[0].image_url.url, /^data:image\/png;base64,/);

  // Dedicated usage is not counted on the Bedrock usage page.
  const usage = await json('/api/usage?range=24h');
  assert.ok(usage.body.models.every((m: { modelId: string }) => m.modelId !== SERVER.id));
});

test('context window drops the oldest turns and reports it', async () => {
  await setServer({ contextSize: 1300, maxTokens: 256, safetyMarginTokens: 0 }, { systemPrompt: '' });
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  const long = 'word '.repeat(700); // ~ 979 tokens at 3.6 chars/token
  const follow = 'more '.repeat(100); // ~ 145 tokens
  await sse(`/api/conversations/${conv.id}/messages`, { content: long, attachmentIds: [], mode: 'dedicated', modelId: '' });
  const events = await sse(`/api/conversations/${conv.id}/messages`, { content: follow, attachmentIds: [], mode: 'dedicated', modelId: '' });
  const notice = events.find((e) => e.type === 'notice');
  assert.ok(notice && notice.type === 'notice' && /oldest/.test(notice.message), JSON.stringify(events));
  const req = gemma.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)!;
  assert.equal(req.body.messages.length, 1);
  assert.equal(req.body.messages[0].content, follow);

  await setServer({ contextStrategy: 'error' });
  const conv2 = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  await sse(`/api/conversations/${conv2.id}/messages`, { content: long, attachmentIds: [], mode: 'dedicated', modelId: '' });
  const ev2 = await sse(`/api/conversations/${conv2.id}/messages`, { content: follow, attachmentIds: [], mode: 'dedicated', modelId: '' });
  const err = ev2.find((e) => e.type === 'error');
  assert.ok(err && err.type === 'error' && /context/.test(err.message), JSON.stringify(ev2));
  await setServer({ contextSize: 8192, maxTokens: 1024, contextStrategy: 'truncate', safetyMarginTokens: 128 });
});

test('documents are read as text for Gemma (DOCX)', async () => {
  const docXml = '<w:document><w:body><w:p><w:r><w:t>Quarterly revenue grew 12%.</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Costs &amp; margins held.</w:t></w:r></w:p></w:body></w:document>';
  const docx = zipSync({ 'word/document.xml': strToU8(docXml) });
  void deflateSync;
  const form = new FormData();
  form.append('file', new File([docx], 'notes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  const meta = (await (await app.request('/api/files', { method: 'POST', headers: { 'x-open-rock-client': 'test' }, body: form })).json()) as { id: string; hasText: boolean };
  assert.equal(meta.hasText, true);
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  await sse(`/api/conversations/${conv.id}/messages`, { content: 'Summarize', attachmentIds: [meta.id], mode: 'dedicated', modelId: '' });
  const req = gemma.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)!;
  const content = req.body.messages.at(-1).content as string;
  assert.match(content, /<file name="notes.docx">\nQuarterly revenue grew 12%.\nCosts & margins held.\n<\/file>/);
});

test('falls back to the Ollama protocol when the server speaks it', async () => {
  gemma.style = 'ollama';
  const st = await json('/api/dedicated/status');
  assert.equal(st.body.apiStyle, 'ollama');
  assert.equal(st.body.contextSize, 131072);
  assert.equal(st.body.vision, true);
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  await setServer({ model: 'gemma3:27b', keepAlive: '30m' });
  const events = await sse(`/api/conversations/${conv.id}/messages`, { content: 'Hi', attachmentIds: [], mode: 'dedicated', modelId: '' });
  assert.equal(textOf(events), 'Ollama says hi', JSON.stringify(events));
  const req = gemma.requests.filter((r) => r.path === '/api/chat').at(-1)!;
  assert.equal(req.body.options.num_ctx, 8192);
  assert.equal(req.body.options.num_predict, 1024);
  assert.equal(req.body.keep_alive, '30m');
  assert.equal(req.auth, `Bearer ${DEDICATED_TOKEN}`);
  gemma.style = 'openai';
});

test('edit and regenerate rewrite history', async () => {
  await json('/api/dedicated/status');
  await setServer({ model: '' });
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  await sse(`/api/conversations/${conv.id}/messages`, { content: 'First', attachmentIds: [], mode: 'dedicated', modelId: '' });
  await sse(`/api/conversations/${conv.id}/messages`, { content: 'Second', attachmentIds: [], mode: 'dedicated', modelId: '' });
  let full = (await json(`/api/conversations/${conv.id}`)).body;
  assert.equal(full.messages.length, 4);
  assert.equal(full.title, 'First');
  await sse(`/api/conversations/${conv.id}/messages`, { content: 'First, edited', attachmentIds: [], mode: 'dedicated', modelId: '', editMessageId: full.messages[0].id });
  full = (await json(`/api/conversations/${conv.id}`)).body;
  assert.equal(full.messages.length, 2);
  assert.equal(full.messages[0].content, 'First, edited');
  await sse(`/api/conversations/${conv.id}/messages`, { content: '', attachmentIds: [], mode: 'dedicated', modelId: '', regenerate: true });
  full = (await json(`/api/conversations/${conv.id}`)).body;
  assert.equal(full.messages.length, 2);
});

test('a wrong Gemma token shows a clear error', async () => {
  const prev = process.env.OPEN_ROCK_DEDICATED_TOKEN;
  const { config } = await import('../src/config.js');
  config.dedicated.token = 'nope';
  const st = await json('/api/dedicated/status');
  assert.equal(st.body.ok, false);
  assert.match(st.body.message, /refused the token/);
  config.dedicated.token = prev!;
});

test('dedicated always uses HTTPS, port 443 by default, and no server is built in', async () => {
  const { DEFAULT_SETTINGS, serverUrl, parseServerAddress } = await import('@open-rock/shared');
  assert.deepEqual(DEFAULT_SETTINGS.dedicated.servers, []);
  assert.equal(serverUrl({ host: '127.0.0.1', port: 443 }), 'https://127.0.0.1');
  assert.equal(serverUrl({ host: '127.0.0.1', port: 8443 }), 'https://127.0.0.1:8443');
  assert.equal(serverUrl({ host: '::1', port: 8443 }), 'https://[::1]:8443');

  assert.deepEqual(parseServerAddress('203.0.113.10'), { host: '203.0.113.10' });
  assert.deepEqual(parseServerAddress(' https://Gemma.Example.com:8443/v1 '), { host: 'gemma.example.com', port: 8443 });
  assert.deepEqual(parseServerAddress('gemma.lan:443'), { host: 'gemma.lan', port: 443 });
  assert.deepEqual(parseServerAddress('::1'), { host: '::1' });
  assert.deepEqual(parseServerAddress('[fe80::1]:8443'), { host: 'fe80::1', port: 8443 });
  for (const bad of ['', 'not a host', 'gemma.lan:', 'user@gemma.lan']) assert.equal(parseServerAddress(bad), null, bad);

  // Without OPEN_ROCK_DEDICATED_HOST the list starts empty.
  const { config } = await import('../src/config.js');
  const { fromStored } = await import('../src/settings.js');
  const envHost = config.dedicated.host;
  config.dedicated.host = '';
  assert.deepEqual(fromStored({}).dedicated.servers, []);
  config.dedicated.host = envHost;
});

test('settings from before the server list move into it', async () => {
  const { fromStored } = await import('../src/settings.js');
  const old = fromStored({ dedicated: { port: 8443, apiKey: 'old-token', displayName: 'Box', model: 'gemma3:4b', authHeader: 'raw', contextSize: 4096, topK: 64, systemPrompt: 'Hi.' } });
  const [srv] = old.dedicated.servers;
  assert.deepEqual(
    { id: srv.id, name: srv.name, host: srv.host, port: srv.port, apiKey: srv.apiKey, authHeader: srv.authHeader, apiStyle: srv.apiStyle, model: srv.model },
    { id: 'env', name: 'Box', host: '127.0.0.1', port: 8443, apiKey: 'old-token', authHeader: 'raw', apiStyle: 'auto', model: 'gemma3:4b' },
  );
  // Model settings that used to apply to every server move onto it; the system prompt stays shared.
  assert.equal(srv.contextSize, 4096);
  assert.equal(srv.topK, 64);
  assert.equal(srv.temperature, null);
  assert.equal(old.dedicated.systemPrompt, 'Hi.');
  for (const k of ['port', 'apiKey', 'displayName', 'model', 'authHeader', 'contextSize']) assert.ok(!(k in old.dedicated), k);
  // Servers saved before model settings lived on them get the old shared values.
  const saved = fromStored({ dedicated: { contextSize: 2048, servers: [{ ...SERVER, id: 'a' }] } });
  assert.equal(saved.dedicated.servers[0].contextSize, 2048);
  assert.equal(saved.dedicated.servers[0].maxImages, DEFAULT_DEDICATED_MODEL.maxImages);
  // Once a list is saved, removing the .env server sticks.
  assert.deepEqual(fromStored({ dedicated: { servers: [] } }).dedicated.servers, []);

  // Bedrock reply settings move into `replies`; the old 4096 default becomes "the model's maximum".
  const b = fromStored({ bedrock: { temperature: 0.3, maxTokens: 4096, stopSequences: ['END'], reasoning: { enabled: true, budgetTokens: 3000 }, showLegacy: false } });
  assert.deepEqual(b.bedrock.replies, { maxTokens: null, temperature: 0.3, topP: null, topK: null, stopSequences: ['END'], thinking: 'on', budgetTokens: 3000, effort: null });
  for (const k of ['temperature', 'maxTokens', 'reasoning', 'showLegacy']) assert.ok(!(k in b.bedrock), k);
  assert.equal(fromStored({ bedrock: { maxTokens: 900 } }).bedrock.replies.maxTokens, 900);
});

test('server addresses and ports are validated, and a port typed into the address is used', async () => {
  const badPort = await setServer({ port: 70000 });
  assert.equal(badPort.status, 400);
  assert.match(badPort.body.error, /port/i);
  const noHost = await setServer({ host: ' ' });
  assert.equal(noHost.status, 400);
  assert.match(noHost.body.error, /hostname or IP address for Gemma/);
  const badHost = await setServer({ host: 'not a host' });
  assert.equal(badHost.status, 400);

  const typed = await setServer({ host: `https://127.0.0.1:${gemma.port}/`, port: 443 });
  assert.equal(typed.status, 200, JSON.stringify(typed.body));
  assert.equal(typed.body.settings.dedicated.servers[0].host, '127.0.0.1');
  assert.equal(typed.body.settings.dedicated.servers[0].port, gemma.port);
});

test('several servers: each is a model-menu entry and chats go to the one picked', async () => {
  const [first] = (await json('/api/settings')).body.settings.dedicated.servers;
  const other = { ...SERVER, id: 'other', name: 'Other box', port: gemmaOtherName.port, apiKey: DEDICATED_TOKEN };
  const put = await json('/api/settings', { method: 'PUT', body: JSON.stringify({ dedicated: { servers: [first, other] } }) });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.settings.dedicated.servers[1].apiKey, '••••••••');
  assert.ok(!JSON.stringify(put.body).includes(DEDICATED_TOKEN));

  const models = await json('/api/models?mode=dedicated');
  assert.deepEqual(models.body.models.map((m: { id: string; name: string }) => [m.id, m.name]), [['gemma', 'Gemma'], ['other', 'Other box']]);

  const st = await json('/api/dedicated/status?server=other');
  assert.equal(st.body.ok, true, st.body.message);
  assert.equal(st.body.endpoint, `https://127.0.0.1:${gemmaOtherName.port}`);
  assert.equal((await json('/api/dedicated/status?server=nope')).status, 404);

  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  const before = { main: gemma.requests.length, other: gemmaOtherName.requests.length };
  const events = await sse(`/api/conversations/${conv.id}/messages`, { content: 'Which box?', attachmentIds: [], mode: 'dedicated', modelId: 'other' });
  assert.equal(textOf(events), 'Hello from Gemma', JSON.stringify(events));
  assert.ok(gemmaOtherName.requests.slice(before.other).some((r) => r.path === '/v1/chat/completions'));
  assert.equal(gemma.requests.length, before.main);
  const saved = (await json(`/api/conversations/${conv.id}`)).body;
  assert.equal(saved.modelId, 'other');
  assert.equal(saved.messages.at(-1).modelName, 'Other box');

  // No server picked: the first one.
  await sse(`/api/conversations/${conv.id}/messages`, { content: 'Default?', attachmentIds: [], mode: 'dedicated', modelId: '' });
  assert.ok(gemma.requests.slice(before.main).some((r) => r.path === '/v1/chat/completions'));

  // A server that was removed.
  const gone = await sse(`/api/conversations/${conv.id}/messages`, { content: 'Hello?', attachmentIds: [], mode: 'dedicated', modelId: 'removed' });
  const err = gone.find((e) => e.type === 'error');
  assert.ok(err && err.type === 'error' && /removed/.test(err.message), JSON.stringify(gone));

  await json('/api/settings', { method: 'PUT', body: JSON.stringify({ dedicated: { servers: [first] } }) });
});

test('a dedicated server can run any model, and what the model can do decides what is offered and sent', async () => {
  const box = await startGemmaMock({ tls: true });
  const [first] = (await json('/api/settings')).body.settings.dedicated.servers;
  const put = (patch: Record<string, unknown> = {}) =>
    json('/api/settings', { method: 'PUT', body: JSON.stringify({ dedicated: { servers: [first, { ...SERVER, id: 'any', name: 'Any', port: box.port, apiKey: DEDICATED_TOKEN, ...patch }] } }) });
  const check = async () => (await json('/api/dedicated/status?server=any')).body;
  const caps = async () => (await json('/api/models?mode=dedicated')).body.models.find((m: { id: string }) => m.id === 'any').capabilities;
  const chat = async (content: string, attachmentIds: string[] = []) => {
    const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
    return sse(`/api/conversations/${conv.id}/messages`, { content, attachmentIds, mode: 'dedicated', modelId: 'any' });
  };
  const last = (p: string) => box.requests.filter((r) => r.path === p).at(-1)!;
  const noticed = (events: StreamEvent[], re: RegExp) => events.some((e) => e.type === 'notice' && re.test(e.message));
  const form = new FormData();
  form.append('file', new File([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')], 'dot.png', { type: 'image/png' }));
  const img = ((await (await app.request('/api/files', { method: 'POST', headers: { 'x-open-rock-client': 'test' }, body: form })).json()) as { id: string }).id;
  try {
    // Ollama running Qwen3: Ollama says it thinks and doesn't read images.
    box.style = 'ollama';
    box.model = 'qwen3:8b';
    box.capabilities = ['completion', 'thinking'];
    await put();
    const st = await check();
    assert.deepEqual([st.ok, st.vision, st.thinking], [true, false, true], st.message);
    assert.deepEqual([(await caps()).images, (await caps()).reasoning], [false, true]);
    await chat('Hi');
    // Asked to think, so Ollama returns the thinking apart from the reply. Sampling is left to the model.
    assert.equal(last('/api/chat').body.think, true);
    assert.equal(last('/api/chat').body.options.temperature, undefined);
    await put({ thinking: 'off' });
    await chat('Hi');
    assert.equal(last('/api/chat').body.think, false);
    // An image in the chat anyway (sent earlier, or to another model) is left out with a note.
    const ev = await chat('What is this?', [img]);
    assert.ok(noticed(ev, /doesn't read images/), JSON.stringify(ev));
    assert.equal(last('/api/chat').body.messages.at(-1).images, undefined);

    // Gemma 3 on Ollama doesn't think, so it gets no "think" (Ollama refuses it for such models).
    box.model = 'gemma3:27b';
    box.capabilities = ['completion', 'vision'];
    await check();
    assert.deepEqual([(await caps()).images, (await caps()).reasoning], [true, false]);
    await chat('Hi');
    assert.equal(last('/api/chat').body.think, undefined);

    // vLLM running gpt-oss, which says nothing about the model: its name says it reasons, at an effort.
    box.style = 'openai';
    box.model = 'openai/gpt-oss-20b';
    await put({ reasoningEffort: 'high' });
    await check();
    assert.deepEqual([(await caps()).images, (await caps()).reasoning], [false, true]);
    await chat('Hi');
    assert.equal(last('/v1/chat/completions').body.reasoning_effort, 'high');
    assert.equal(last('/v1/chat/completions').body.chat_template_kwargs, undefined);

    // Qwen3 on vLLM: thinking is switched through the chat template, and <think> left in the text becomes thinking.
    box.model = 'Qwen/Qwen3-8B';
    box.reply = ['<thi', 'nk>Let me', ' see.</th', 'ink>\n\nHello', ' there'];
    await put({ thinking: 'on' });
    await check();
    const thought = await chat('Hi');
    assert.deepEqual(last('/v1/chat/completions').body.chat_template_kwargs, { enable_thinking: true });
    assert.equal(textOf(thought), 'Hello there');
    assert.equal(thought.map((e) => (e.type === 'reasoning' ? e.text : '')).join(''), 'Let me see.');
    const saved = (await json(`/api/conversations/${(thought.find((e) => e.type === 'start') as { conversation: { id: string } }).conversation.id}`)).body;
    assert.equal(saved.messages.at(-1).reasoning, 'Let me see.');

    // A model nobody describes, that turns out to be text-only: the image is dropped once, then no longer offered.
    box.model = 'meta-llama/Llama-3.1-8B-Instruct';
    box.reply = undefined;
    box.textOnly = true;
    await put();
    await check();
    assert.deepEqual([(await caps()).images, (await caps()).reasoning], [true, false]);
    const before = box.requests.length;
    const refused = await chat('What is this?', [img]);
    assert.equal(textOf(refused), 'Hello from Gemma', JSON.stringify(refused));
    assert.ok(noticed(refused, /Llama-3\.1-8B-Instruct doesn't read images/), JSON.stringify(refused));
    const sent = box.requests.slice(before).filter((r) => r.path === '/v1/chat/completions');
    assert.equal(sent.length, 2);
    assert.match(sent[1].body.messages.at(-1).content, /dot\.png[\s\S]*What is this\?/);
    assert.equal((await caps()).images, false);
    assert.equal((await check()).vision, false);

    // The server's own context limit wins over a larger setting.
    await put({ contextSize: 65536 });
    const fitted = await chat('Hi');
    const ctx = fitted.find((e) => e.type === 'context');
    assert.ok(ctx && ctx.type === 'context');
    assert.equal(ctx.context.contextSize, 32768);
  } finally {
    await json('/api/settings', { method: 'PUT', body: JSON.stringify({ dedicated: { servers: [first] } }) });
    await box.close();
  }
});

test('the .env token is only sent to the .env server', async () => {
  const { dedicatedToken } = await import('../src/providers/dedicated.js');
  const base = { ...DEFAULT_DEDICATED_MODEL, ...SERVER, authHeader: 'auto' as const, apiStyle: 'auto' as const };
  assert.equal(dedicatedToken({ ...base, host: '127.0.0.1' }), DEDICATED_TOKEN);
  assert.equal(dedicatedToken({ ...base, host: '203.0.113.10' }), '');
  assert.equal(dedicatedToken({ ...base, host: '203.0.113.10', apiKey: 'its-own' }), 'its-own');
});

test('HTTPS: accepts a self-signed certificate', async () => {
  await setServer({ port: gemma.port, model: '' });
  const s = await json('/api/settings');
  assert.ok(!('allowSelfSigned' in s.body.settings.dedicated.servers[0]));
  const ok = await json('/api/dedicated/status');
  assert.equal(ok.body.ok, true, ok.body.message);
  assert.equal(ok.body.endpoint, `https://127.0.0.1:${gemma.port}`);
});

test('HTTPS: accepts a self-signed certificate issued for another name', async () => {
  await setServer({ port: gemmaOtherName.port });
  const st = await json('/api/dedicated/status');
  assert.equal(st.body.ok, true, st.body.message);
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  const events = await sse(`/api/conversations/${conv.id}/messages`, { content: 'Handshake?', attachmentIds: [], mode: 'dedicated', modelId: '' });
  assert.equal(textOf(events), 'Hello from Gemma', JSON.stringify(events));
  const req = gemmaOtherName.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)!;
  assert.equal(req.auth, `Bearer ${DEDICATED_TOKEN}`);
  await setServer({ port: gemma.port });
});

test('HTTPS: accepts any certificate, and servers that only speak old TLS', async () => {
  for (const kind of ['expired', 'weak', 'ed25519', 'privateca', 'oldtls'] as const) {
    const server = await startGemmaMock({ tls: kind });
    try {
      await setServer({ port: server.port });
      const st = await json('/api/dedicated/status');
      assert.equal(st.body.ok, true, `${kind}: ${st.body.message}`);
      const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
      const events = await sse(`/api/conversations/${conv.id}/messages`, { content: kind, attachmentIds: [], mode: 'dedicated', modelId: '' });
      assert.equal(textOf(events), 'Hello from Gemma', `${kind}: ${JSON.stringify(events)}`);
    } finally {
      await server.close();
    }
  }
  await setServer({ port: gemma.port });
});

test('Bedrock still verifies certificates normally', async () => {
  // Only the Gemma client skips verification; nothing global was switched off.
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  const https = await import('node:https');
  assert.notEqual((https.globalAgent.options as { rejectUnauthorized?: boolean }).rejectUnauthorized, false);
});

test('a port without HTTPS explains the mismatch', async () => {
  await setServer({ port: gemmaPlain.port });
  const st = await json('/api/dedicated/status');
  assert.equal(st.body.ok, false);
  assert.match(st.body.message, /doesn't speak HTTPS/);
  await setServer({ port: gemma.port });
  const back = await json('/api/dedicated/status');
  assert.equal(back.body.ok, true, back.body.message);
});

test('the Gemma token can be set in Settings, is masked, and falls back to .env when cleared', async () => {
  const custom = 'token-from-settings';
  const put = await setServer({ apiKey: custom });
  assert.equal(put.body.settings.dedicated.servers[0].apiKey, '••••••••');
  assert.ok(!JSON.stringify(put.body).includes(custom));
  const stored = JSON.parse(fs.readFileSync(path.join(process.env.OPEN_ROCK_DATA_DIR!, 'settings.json'), 'utf8'));
  assert.equal(stored.dedicated.servers[0].apiKey, custom);

  // The mock only accepts DEDICATED_TOKEN, so the settings token must be the one being sent.
  let before = gemma.requests.length;
  const wrong = await json('/api/dedicated/status');
  assert.equal(wrong.body.ok, false);
  assert.match(wrong.body.message, /refused the token/);
  assert.ok(gemma.requests.slice(before).some((r) => r.auth === `Bearer ${custom}`));
  assert.ok(gemma.requests.slice(before).every((r) => r.auth !== `Bearer ${DEDICATED_TOKEN}`));

  // Saving the list back with the masked value keeps the stored token.
  await setServer({ port: gemma.port });
  before = gemma.requests.length;
  await json('/api/dedicated/status');
  assert.ok(gemma.requests.slice(before).some((r) => r.auth === `Bearer ${custom}`));

  // The right token in Settings works.
  await setServer({ apiKey: DEDICATED_TOKEN });
  const ok = await json('/api/dedicated/status');
  assert.equal(ok.body.ok, true, ok.body.message);
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  const events = await sse(`/api/conversations/${conv.id}/messages`, { content: 'Token check', attachmentIds: [], mode: 'dedicated', modelId: '' });
  assert.equal(textOf(events), 'Hello from Gemma', JSON.stringify(events));

  // Clearing it falls back to OPEN_ROCK_DEDICATED_TOKEN.
  const cleared = await setServer({ apiKey: '' });
  assert.equal(cleared.body.settings.dedicated.servers[0].apiKey, '');
  assert.equal(cleared.body.info.dedicatedEnvTokenHost, '127.0.0.1');
  const back = await json('/api/dedicated/status');
  assert.equal(back.body.ok, true, back.body.message);
  assert.equal(gemma.requests.at(-1)!.auth, `Bearer ${DEDICATED_TOKEN}`);
});

test('finds the header a server wants the token in, and remembers it for chats', async () => {
  await setServer({ port: gemma.port, apiKey: '', authHeader: 'auto' });
  gemma.expect = 'x-api-key';
  const st = await json('/api/dedicated/status');
  assert.equal(st.body.ok, true, st.body.message);
  assert.equal(st.body.authHeader, 'x-api-key');
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  const events = await sse(`/api/conversations/${conv.id}/messages`, { content: 'Which header?', attachmentIds: [], mode: 'dedicated', modelId: '' });
  assert.equal(textOf(events), 'Hello from Gemma', JSON.stringify(events));
  const chatReq = gemma.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)!;
  assert.equal(chatReq.apiKey, DEDICATED_TOKEN);
  gemma.expect = 'bearer';
  // A chat that hits 401 with the remembered header re-detects and retries once.
  const conv2 = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  const events2 = await sse(`/api/conversations/${conv2.id}/messages`, { content: 'Switched back', attachmentIds: [], mode: 'dedicated', modelId: '' });
  assert.equal(textOf(events2), 'Hello from Gemma', JSON.stringify(events2));
});

test('a pasted "Bearer …" token or one in quotes still works', async () => {
  for (const pasted of [`Bearer ${DEDICATED_TOKEN}`, `"${DEDICATED_TOKEN}"`, `  ${DEDICATED_TOKEN}\n`, `Authorization: Bearer ${DEDICATED_TOKEN}`, `••••••••${DEDICATED_TOKEN}`]) {
    await setServer({ apiKey: pasted });
    const st = await json('/api/dedicated/status');
    assert.equal(st.body.ok, true, `${JSON.stringify(pasted)}: ${st.body.message}`);
    assert.equal(gemma.requests.at(-1)!.auth, `Bearer ${DEDICATED_TOKEN}`);
  }
  await setServer({ apiKey: '' });
});

test('a refused token shows what the server answered, without the token', async () => {
  await setServer({ apiKey: 'not-the-token' });
  const st = await json('/api/dedicated/status');
  assert.equal(st.body.ok, false);
  assert.match(st.body.message, /refused the token \(HTTP 401\) in every format/);
  assert.ok(st.body.details.length >= 2, JSON.stringify(st.body.details));
  assert.match(st.body.details.join('\n'), /GET \/v1\/models \(token as Authorization: Bearer\): HTTP 401\. Server: mock-gemma\./);
  assert.ok(!JSON.stringify(st.body).includes('not-the-token'), 'token is redacted from the server answers');

  gemma.expect = 'basic';
  const basic = await json('/api/dedicated/status');
  assert.match(basic.body.message, /username and password \(HTTP Basic auth\)/);
  gemma.expect = 'bearer';
  await setServer({ apiKey: '' });
  const back = await json('/api/dedicated/status');
  assert.equal(back.body.ok, true, back.body.message);
});

test('nginx-style bare key: detected, and Ollama\'s Host refusal is explained instead of blaming the token', async () => {
  await setServer({ port: gemma.port, apiKey: DEDICATED_TOKEN, authHeader: 'auto' });
  gemma.expect = 'raw';
  gemma.hostCheck = true;
  const refused = await json('/api/dedicated/status');
  assert.equal(refused.body.ok, false);
  assert.match(refused.body.message, /accepted the token, but Ollama behind it refused the request \(HTTP 403, empty body\)/);
  assert.match(refused.body.message, /proxy_set_header Host localhost:11434;/);
  assert.match(refused.body.details.join('\n'), /token as Authorization \(no prefix\)\): HTTP 403\. Server: mock-gemma\. Empty body\./);

  // A chat gets the same explanation.
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  const evs = await sse(`/api/conversations/${conv.id}/messages`, { content: 'hi', attachmentIds: [], mode: 'dedicated', modelId: '' });
  const err = evs.find((e) => e.type === 'error');
  assert.ok(err && err.type === 'error' && /Host localhost:11434/.test(err.message), JSON.stringify(evs));

  // With the nginx fix in place, the bare key is used for status and chat.
  gemma.hostCheck = false;
  const ok = await json('/api/dedicated/status');
  assert.equal(ok.body.ok, true, ok.body.message);
  assert.equal(ok.body.authHeader, 'raw');
  const conv2 = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  const evs2 = await sse(`/api/conversations/${conv2.id}/messages`, { content: 'hi', attachmentIds: [], mode: 'dedicated', modelId: '' });
  assert.equal(textOf(evs2), 'Hello from Gemma', JSON.stringify(evs2));
  const chatReq = gemma.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)!;
  assert.equal(chatReq.auth, DEDICATED_TOKEN);
  gemma.expect = 'bearer';
  await setServer({ apiKey: '' });
});

test('keep_alive is sent the way Ollama parses it', async () => {
  const { keepAliveValue } = await import('../src/providers/dedicated.js');
  assert.equal(keepAliveValue('-1'), -1);
  assert.equal(keepAliveValue('300'), 300);
  assert.equal(keepAliveValue('30m'), '30m');
  assert.equal(keepAliveValue(' 1h '), '1h');
  assert.equal(keepAliveValue(''), null);

  gemma.style = 'ollama';
  await setServer({ apiStyle: 'ollama', model: 'gemma3:27b', keepAlive: '-1' });
  await json('/api/dedicated/status');
  const conv = (await json('/api/conversations', { method: 'POST', body: JSON.stringify({ mode: 'dedicated' }) })).body;
  await sse(`/api/conversations/${conv.id}/messages`, { content: 'hi', attachmentIds: [], mode: 'dedicated', modelId: '' });
  const req = gemma.requests.filter((r) => r.path === '/api/chat').at(-1)!;
  assert.strictEqual(req.body.keep_alive, -1);
  gemma.style = 'openai';
  await setServer({ apiStyle: 'auto', model: '', keepAlive: '' });
});
