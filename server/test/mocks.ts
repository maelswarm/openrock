// Local stand-ins for Bedrock and the Gemma server, used by the end-to-end tests.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { EventStreamCodec } from '@smithy/core/event-streams';
import { fromUtf8, toUtf8 } from '@smithy/core/serde';

export const DEDICATED_TOKEN = 'test-gemma-token';

/** Set MOCK_RICH=1 to stream a longer Markdown reply (used for UI screenshots). */
const RICH = process.env.MOCK_RICH === '1';
const RICH_TEXT = [
  'An **inference profile** routes a request to a model across one or more AWS Regions.',
  '\n\n- `us.` profiles stay in US Regions\n- `global.` profiles can use any commercial Region\n\n',
  '```python\nimport boto3\n\nclient = boto3.client("bedrock-runtime", region_name="us-east-1")\n',
  'resp = client.converse(\n    modelId="us.anthropic.claude-sonnet-4-5-20250929-v1:0",\n    messages=[{"role": "user", "content": [{"text": "Hi"}]}],\n)\nprint(resp["output"]["message"]["content"][0]["text"])\n```\n\n',
  '| Prefix | Routes within |\n| --- | --- |\n| `us.` | US Regions |\n| `eu.` | EU Regions |\n| `global.` | All commercial Regions |\n\nCost is the same as calling the model directly; $E = mc^2$ is unrelated.',
];
export const BEDROCK_KEY = 'test-bedrock-key';

function readBody(req: http.IncomingMessage | http2.Http2ServerRequest): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data));
  });
}

// ---------------- Gemma (OpenAI-compatible or Ollama) ----------------

export interface GemmaMock {
  url: string;
  port: number;
  style: 'openai' | 'ollama';
  /** How the mock expects the token: Authorization: Bearer (default), an X-API-Key header, or HTTP Basic (always refuses). */
  expect: 'bearer' | 'x-api-key' | 'raw' | 'basic';
  /** After the token check, answer like Ollama does when the Host header isn't localhost: bare 403. */
  hostCheck: boolean;
  requests: { path: string; body: any; auth: string | undefined; apiKey: string | undefined }[];
  close(): Promise<void>;
}

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Kinds of certificate (see fixtures/README.md), or 'oldtls' for a self-signed one served over TLS 1.0/1.1 only. */
export type MockTls = 'othername' | 'expired' | 'weak' | 'ed25519' | 'privateca' | 'oldtls';

/** Pass `tls: true` to serve HTTPS with a self-signed certificate, or name another kind of certificate. */
export async function startGemmaMock(opts: { tls?: boolean | MockTls } = {}): Promise<GemmaMock> {
  const mock: GemmaMock = { url: '', port: 0, style: 'openai', expect: 'bearer', hostCheck: false, requests: [], close: async () => undefined };
  const handler: http.RequestListener = async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : null;
    const path = req.url ?? '';
    const apiKey = req.headers['x-api-key'] as string | undefined;
    mock.requests.push({ path, body, auth: req.headers.authorization, apiKey });
    const authorized =
      mock.expect === 'bearer'
        ? req.headers.authorization === `Bearer ${DEDICATED_TOKEN}`
        : mock.expect === 'raw'
          ? req.headers.authorization === DEDICATED_TOKEN
          : mock.expect === 'x-api-key'
            ? apiKey === DEDICATED_TOKEN
            : false;
    if (!authorized) {
      const h: Record<string, string> = { 'Content-Type': 'application/json', Server: 'mock-gemma' };
      if (mock.expect === 'basic') h['WWW-Authenticate'] = 'Basic realm="gemma"';
      res.writeHead(401, h);
      res.end(JSON.stringify({ error: 'unauthorized', echo: req.headers.authorization ?? apiKey ?? null }));
      return;
    }
    if (mock.hostCheck) {
      res.writeHead(403, { Server: 'mock-gemma' });
      res.end();
      return;
    }
    if (mock.style === 'openai') {
      if (path === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'google/gemma-3-27b-it', object: 'model', max_model_len: 32768 }] }));
        return;
      }
      if (path === '/v1/chat/completions') {
        if (!body.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Plain reply.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 42, completion_tokens: 3 } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const piece of RICH ? RICH_TEXT : ['Hello', ' from', ' Gemma']) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 57, completion_tokens: 3 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
    } else {
      if (path === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'gemma3:27b' }] }));
        return;
      }
      if (path === '/api/show') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model_info: { 'gemma3.context_length': 131072 }, capabilities: ['completion', 'vision'] }));
        return;
      }
      if (path === '/api/chat') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: 'Ollama' }, done: false })}\n`);
        res.write(`${JSON.stringify({ message: { role: 'assistant', content: ' says hi' }, done: false })}\n`);
        res.end(`${JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 4 })}\n`);
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  };
  const certName = opts.tls === true || opts.tls === 'oldtls' ? 'selfsigned' : opts.tls;
  const server = opts.tls
    ? https.createServer(
        {
          key: fs.readFileSync(path.join(fixtures, `${certName}-key.pem`)),
          cert: fs.readFileSync(path.join(fixtures, `${certName}-cert.pem`)),
          // Let the server load weak keys and speak old TLS versions, like old appliances do.
          ciphers: 'DEFAULT:@SECLEVEL=0',
          minVersion: 'TLSv1',
          ...(opts.tls === 'oldtls' ? { maxVersion: 'TLSv1.1' as const } : {}),
        },
        handler,
      )
    : http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  mock.port = (server.address() as AddressInfo).port;
  mock.url = `${opts.tls ? 'https' : 'http'}://127.0.0.1:${mock.port}`;
  mock.close = () => new Promise((r) => server.close(() => r()));
  return mock;
}

// ---------------- Bedrock ----------------

export interface BedrockMock {
  controlUrl: string;
  runtimeUrl: string;
  runtimeRequests: { modelId: string; body: any; auth: string | undefined; stream: boolean }[];
  controlAuth: (string | undefined)[];
  /** Simulate an API key without permission to list profiles / models. */
  deny: { profiles: boolean; models: boolean };
  close(): Promise<void>;
}

const codec = new EventStreamCodec(toUtf8, fromUtf8);

function frame(eventType: string, payload: unknown): Uint8Array {
  return codec.encode({
    headers: {
      ':event-type': { type: 'string', value: eventType },
      ':content-type': { type: 'string', value: 'application/json' },
      ':message-type': { type: 'string', value: 'event' },
    },
    body: fromUtf8(JSON.stringify(payload)),
  });
}

const FOUNDATION_MODELS = [
  {
    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
    modelId: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    modelName: 'Claude Sonnet 4.5',
    providerName: 'Anthropic',
    inputModalities: ['TEXT', 'IMAGE'],
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    inferenceTypesSupported: ['INFERENCE_PROFILE'],
    modelLifecycle: { status: 'ACTIVE' },
  },
  {
    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0',
    modelId: 'amazon.nova-micro-v1:0',
    modelName: 'Nova Micro',
    providerName: 'Amazon',
    inputModalities: ['TEXT'],
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    inferenceTypesSupported: ['ON_DEMAND', 'INFERENCE_PROFILE'],
    modelLifecycle: { status: 'ACTIVE' },
  },
  {
    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/mistral.mistral-7b-instruct-v0:2',
    modelId: 'mistral.mistral-7b-instruct-v0:2',
    modelName: 'Mistral 7B Instruct',
    providerName: 'Mistral AI',
    inputModalities: ['TEXT'],
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    inferenceTypesSupported: ['ON_DEMAND'],
    modelLifecycle: { status: 'ACTIVE' },
  },
  {
    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0:28k',
    modelId: 'anthropic.claude-3-sonnet-20240229-v1:0:28k',
    modelName: 'Claude 3 Sonnet',
    providerName: 'Anthropic',
    inputModalities: ['TEXT', 'IMAGE'],
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    inferenceTypesSupported: ['PROVISIONED'],
    modelLifecycle: { status: 'LEGACY' },
  },
  {
    // Gemma 3 on Bedrock is in its legacy period: still usable, so it must be listed.
    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/google.gemma-3-12b-it',
    modelId: 'google.gemma-3-12b-it',
    modelName: 'Gemma 3 12B IT',
    providerName: 'Google',
    inputModalities: ['TEXT', 'IMAGE'],
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    inferenceTypesSupported: ['ON_DEMAND'],
    modelLifecycle: { status: 'LEGACY', endOfLifeTime: '2027-03-30T00:00:00Z' },
  },
  {
    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-oss-120b-1:0',
    modelId: 'openai.gpt-oss-120b-1:0',
    modelName: 'gpt-oss-120b',
    providerName: 'OpenAI',
    inputModalities: ['TEXT'],
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    inferenceTypesSupported: ['ON_DEMAND'],
    modelLifecycle: { status: 'ACTIVE' },
  },
  {
    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-7',
    modelId: 'anthropic.claude-opus-4-7',
    modelName: 'Claude Opus 4.7',
    providerName: 'Anthropic',
    inputModalities: ['TEXT', 'IMAGE'],
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    inferenceTypesSupported: ['ON_DEMAND'],
    modelLifecycle: { status: 'ACTIVE' },
  },
  {
    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-5',
    modelId: 'anthropic.claude-opus-5-5',
    modelName: 'Claude Opus 5.5',
    providerName: 'Anthropic',
    inputModalities: ['TEXT', 'IMAGE'],
    outputModalities: ['TEXT'],
    responseStreamingSupported: true,
    inferenceTypesSupported: ['ON_DEMAND'],
    modelLifecycle: { status: 'ACTIVE' },
  },
  {
    modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.rerank-v1:0',
    modelId: 'amazon.rerank-v1:0',
    modelName: 'Rerank',
    providerName: 'Amazon',
    inputModalities: ['TEXT'],
    outputModalities: ['TEXT'],
    responseStreamingSupported: false,
    inferenceTypesSupported: ['ON_DEMAND'],
    modelLifecycle: { status: 'ACTIVE' },
  },
];

const PROFILES = [
  {
    inferenceProfileName: 'US Claude Sonnet 4.5',
    inferenceProfileArn: 'arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    inferenceProfileId: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    status: 'ACTIVE',
    type: 'SYSTEM_DEFINED',
    models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0' }],
  },
  {
    inferenceProfileName: 'Global Claude Sonnet 4.5',
    inferenceProfileArn: 'arn:aws:bedrock:us-east-1:123:inference-profile/global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    inferenceProfileId: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
    status: 'ACTIVE',
    type: 'SYSTEM_DEFINED',
    models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0' }],
  },
  {
    inferenceProfileName: 'US Nova Micro',
    inferenceProfileArn: 'arn:aws:bedrock:us-east-1:123:inference-profile/us.amazon.nova-micro-v1:0',
    inferenceProfileId: 'us.amazon.nova-micro-v1:0',
    status: 'ACTIVE',
    type: 'SYSTEM_DEFINED',
    models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0' }],
  },
];

const NOW = '2026-01-01T00:00:00Z';

/** Models the account set up itself, one of each kind, plus ones that can't be used. */
const OWN_MODELS: Record<string, unknown> = {
  '/provisioned-model-throughputs': {
    provisionedModelSummaries: [
      {
        provisionedModelName: 'Claude 3 Sonnet 28k',
        provisionedModelArn: 'arn:aws:bedrock:us-east-1:123:provisioned-model/pt-sonnet',
        modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0:28k',
        desiredModelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0:28k',
        foundationModelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0:28k',
        modelUnits: 1,
        desiredModelUnits: 1,
        status: 'InService',
        creationTime: NOW,
        lastModifiedTime: NOW,
      },
    ],
  },
  '/model-customization/custom-model-deployments': {
    modelDeploymentSummaries: [
      { customModelDeploymentArn: 'arn:aws:bedrock:us-east-1:123:custom-model-deployment/dep1', customModelDeploymentName: 'Tuned Nova', modelArn: 'arn:aws:bedrock:us-east-1:123:custom-model/nova-tuned', createdAt: NOW, status: 'Active' },
      { customModelDeploymentArn: 'arn:aws:bedrock:us-east-1:123:custom-model-deployment/dep2', customModelDeploymentName: 'Broken', modelArn: 'arn:aws:bedrock:us-east-1:123:custom-model/x', createdAt: NOW, status: 'Failed' },
    ],
  },
  '/imported-models': {
    modelSummaries: [
      { modelArn: 'arn:aws:bedrock:us-east-1:123:imported-model/llama-ft', modelName: 'My Llama', creationTime: NOW, modelArchitecture: 'llama' },
      { modelArn: 'arn:aws:bedrock:us-east-1:123:imported-model/qwen-ft', modelName: 'My Qwen', creationTime: NOW, modelArchitecture: 'qwen2' },
    ],
  },
  '/marketplace-model/endpoints': {
    marketplaceModelEndpoints: [
      {
        endpointArn: 'arn:aws:sagemaker:us-east-1:123:endpoint/gemma-3-27b',
        modelSourceIdentifier: 'arn:aws:sagemaker:us-east-1:aws:hub-content/SageMakerPublicHub/Model/huggingface-vlm-gemma-3-27b-instruct/1.0.0',
        status: 'REGISTERED',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  },
};

export async function startBedrockMock(): Promise<BedrockMock> {
  const mock: BedrockMock = { controlUrl: '', runtimeUrl: '', runtimeRequests: [], controlAuth: [], deny: { profiles: false, models: false }, close: async () => undefined };

  const control = http.createServer(async (req, res) => {
    mock.controlAuth.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${BEDROCK_KEY}`) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'x-amzn-errortype': 'UnrecognizedClientException' });
      res.end(JSON.stringify({ message: 'The security token included in the request is invalid.' }));
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('Content-Type', 'application/json');
    if ((url.pathname === '/inference-profiles' && mock.deny.profiles) || (url.pathname === '/foundation-models' && mock.deny.models)) {
      res.writeHead(403, { 'x-amzn-errortype': 'AccessDeniedException' });
      res.end(JSON.stringify({ message: 'User is not authorized to perform this action' }));
      return;
    }
    if (url.pathname === '/foundation-models') {
      res.end(JSON.stringify({ modelSummaries: FOUNDATION_MODELS }));
    } else if (url.pathname === '/inference-profiles') {
      const type = url.searchParams.get('type');
      res.end(JSON.stringify({ inferenceProfileSummaries: type === 'APPLICATION' ? [] : PROFILES }));
    } else if (OWN_MODELS[url.pathname]) {
      res.end(JSON.stringify(OWN_MODELS[url.pathname]));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });

  const runtime = http2.createServer(async (req, res) => {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : {};
    const m = /^\/model\/([^/]+)\/(converse-stream|converse)$/.exec(req.url ?? '');
    const modelId = m ? decodeURIComponent(m[1]) : '';
    const stream = m?.[2] === 'converse-stream';
    mock.runtimeRequests.push({ modelId, body, auth: req.headers.authorization as string | undefined, stream });
    if (req.headers.authorization !== `Bearer ${BEDROCK_KEY}`) {
      res.writeHead(403, { 'Content-Type': 'application/json', 'x-amzn-errortype': 'UnrecognizedClientException' });
      res.end(JSON.stringify({ message: 'The security token included in the request is invalid.' }));
      return;
    }
    if ((modelId.startsWith('mistral.mistral-7b') || modelId.includes('nosys')) && body.system) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'x-amzn-errortype': 'ValidationException' });
      res.end(JSON.stringify({ message: "This model doesn't support system messages." }));
      return;
    }
    if (!stream) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: 'Non-streamed.' }] } }, stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, metrics: { latencyMs: 10 } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.amazon.eventstream' });
    res.write(frame('messageStart', { role: 'assistant' }));
    if (body.additionalModelRequestFields?.thinking) {
      res.write(frame('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'Let me think.' } } }));
    }
    for (const t of RICH ? RICH_TEXT : ['Hello', ' from', ' Bedrock']) res.write(frame('contentBlockDelta', { contentBlockIndex: 1, delta: { text: t } }));
    res.write(frame('contentBlockStop', { contentBlockIndex: 1 }));
    res.write(frame('messageStop', { stopReason: 'end_turn' }));
    res.end(frame('metadata', { usage: { inputTokens: 120, outputTokens: 3, totalTokens: 123, cacheReadInputTokens: 10 }, metrics: { latencyMs: 321 } }));
  });

  await new Promise<void>((r) => control.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => runtime.listen(0, '127.0.0.1', r));
  mock.controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`;
  mock.runtimeUrl = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}`;
  mock.close = async () => {
    await new Promise((r) => control.close(() => r(null)));
    await new Promise((r) => runtime.close(() => r(null)));
  };
  return mock;
}
