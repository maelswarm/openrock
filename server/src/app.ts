import fs from 'node:fs';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import type { DeepPartial, HealthResponse, Mode, SendMessageRequest, Settings, TestResult, UsageRange } from '@open-rock/shared';
import { config } from './config.js';
import { getSettings, maskedSettings, updateSettings } from './settings.js';
import { bedrockApiKey, friendlyAwsError } from './aws/clients.js';
import { customModelInfos, invalidateModelCache, listBedrockModels } from './providers/bedrock-models.js';
import { dedicatedStatus } from './providers/dedicated.js';
import { createConversation, deleteConversation, getConversation, listConversations, saveConversation, summarize } from './store/conversations.js';
import { deleteFile, getMeta, readBytes, saveUpload } from './store/files.js';
import { dedicatedModelInfo, runChat } from './chat.js';
import { usageReport } from './usage-report.js';
import { HttpError, errorMessage, timingSafeEqualStr } from './util.js';

export const CLIENT_HEADER = 'x-open-rock-client';

function settingsPayload() {
  const s = getSettings();
  return {
    settings: maskedSettings(s),
    info: {
      version: config.version,
      dedicatedEnvTokenHost: config.dedicated.token ? config.dedicated.host : '',
      bedrockKeyFromEnv: !s.aws.bedrockApiKey && !!process.env.AWS_BEARER_TOKEN_BEDROCK,
    },
  };
}

function parseMode(v: string | undefined): Mode {
  return v === 'dedicated' ? 'dedicated' : 'bedrock';
}

export function createApp() {
  const app = new Hono();

  app.use(
    '/api/*',
    cors({
      origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Content-Type', 'Authorization', CLIENT_HEADER],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  app.get('/api/health', (c) => c.json<HealthResponse>({ ok: true, name: 'open-rock', version: config.version, authRequired: !!config.authToken }));

  // Every other API call needs the client header (forces a CORS preflight, so other sites can't drive the API)
  // and, when configured, the access token.
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    if (!c.req.header(CLIENT_HEADER)) throw new HttpError(400, `Missing ${CLIENT_HEADER} header.`);
    if (config.authToken) {
      const h = c.req.header('authorization') ?? '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (!token || !timingSafeEqualStr(token, config.authToken)) throw new HttpError(401, 'Access token required.');
    }
    return next();
  });

  // ----- Settings -----
  app.get('/api/settings', (c) => c.json(settingsPayload()));

  app.put('/api/settings', async (c) => {
    const patch = (await c.req.json()) as DeepPartial<Settings>;
    if (patch.aws || patch.bedrock?.crossRegion !== undefined || patch.bedrock?.customModels) {
      invalidateModelCache();
    }
    await updateSettings(patch);
    return c.json(settingsPayload());
  });

  app.post('/api/bedrock/test', async (c) => {
    const s = getSettings();
    if (!bedrockApiKey(s.aws)) return c.json<TestResult>({ ok: false, message: 'Add your Amazon Bedrock API key first.' });
    try {
      const models = await listBedrockModels(s, true);
      return c.json<TestResult>({ ok: true, message: `Connected to Bedrock in ${s.aws.region}: ${models.length} chat models available.` });
    } catch (err) {
      return c.json<TestResult>({ ok: false, message: friendlyAwsError(err) });
    }
  });

  app.get('/api/dedicated/status', async (c) => {
    const id = c.req.query('server') ?? '';
    const servers = getSettings().dedicated.servers;
    const srv = id ? servers.find((s) => s.id === id) : servers[0];
    if (!srv) throw new HttpError(404, id ? 'No dedicated server has that ID.' : 'No dedicated servers yet. Add one in Settings → Dedicated.');
    return c.json(await dedicatedStatus(srv));
  });

  // ----- Models -----
  app.get('/api/models', async (c) => {
    const mode = parseMode(c.req.query('mode'));
    const s = getSettings();
    if (mode === 'dedicated') return c.json({ models: s.dedicated.servers.map((srv) => dedicatedModelInfo(srv)) });
    try {
      return c.json({ models: await listBedrockModels(s, c.req.query('refresh') === '1') });
    } catch (err) {
      // Still offer the user's own model IDs so chatting works without list permissions.
      return c.json({ models: customModelInfos(s), error: friendlyAwsError(err) });
    }
  });

  // ----- Conversations -----
  app.get('/api/conversations', (c) => c.json({ conversations: listConversations() }));

  app.post('/api/conversations', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { mode?: Mode; modelId?: string; modelName?: string; title?: string };
    const conv = await createConversation({ mode: parseMode(body.mode), modelId: body.modelId ?? '', modelName: body.modelName ?? '', title: body.title });
    return c.json(conv, 201);
  });

  app.get('/api/conversations/:id', (c) => c.json(getConversation(c.req.param('id'))));

  app.patch('/api/conversations/:id', async (c) => {
    const conv = getConversation(c.req.param('id'));
    const body = (await c.req.json()) as { title?: string; systemPrompt?: string | null };
    if (typeof body.title === 'string' && body.title.trim()) conv.title = body.title.trim().slice(0, 120);
    if (body.systemPrompt === null) delete conv.systemPrompt;
    else if (typeof body.systemPrompt === 'string') conv.systemPrompt = body.systemPrompt;
    conv.updatedAt = Date.now();
    await saveConversation(conv);
    return c.json(summarize(conv));
  });

  app.delete('/api/conversations/:id', async (c) => {
    await deleteConversation(c.req.param('id'));
    return c.body(null, 204);
  });

  app.post('/api/conversations/:id/messages', async (c) => {
    const conv = getConversation(c.req.param('id'));
    const body = (await c.req.json()) as SendMessageRequest;
    body.mode = parseMode(body.mode);
    body.attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds : [];
    body.content = typeof body.content === 'string' ? body.content : '';
    return streamSSE(
      c,
      async (stream) => {
        const ctrl = new AbortController();
        stream.onAbort(() => ctrl.abort());
        const ping = setInterval(() => {
          stream.write(': ping\n\n').catch(() => undefined);
        }, 15_000);
        try {
          await runChat(conv, body, (ev) => stream.writeSSE({ data: JSON.stringify(ev) }), ctrl.signal);
        } finally {
          clearInterval(ping);
        }
      },
      async (err, stream) => {
        const message = err instanceof HttpError ? err.message : errorMessage(err);
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', message }) });
      },
    );
  });

  // ----- Files -----
  app.post(
    '/api/files',
    bodyLimit({ maxSize: config.maxUploadBytes + 1024 * 1024, onError: () => { throw new HttpError(413, `Files can be up to ${config.maxUploadBytes / 1048576} MB.`); } }),
    async (c) => {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw new HttpError(400, 'Send the file in a "file" form field.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      return c.json(await saveUpload(file.name, file.type, bytes), 201);
    },
  );

  app.get('/api/files/:id/meta', async (c) => c.json(await getMeta(c.req.param('id'))));

  app.get('/api/files/:id', async (c) => {
    const meta = await getMeta(c.req.param('id'));
    const bytes = await readBytes(meta.id);
    const safeName = meta.name.replace(/["\\\r\n]/g, '_');
    return c.body(bytes as unknown as ArrayBuffer, 200, {
      'Content-Type': meta.mime || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
  });

  app.delete('/api/files/:id', async (c) => {
    await deleteFile(c.req.param('id'));
    return c.body(null, 204);
  });

  // ----- Usage -----
  app.get('/api/usage', (c) => {
    const r = c.req.query('range');
    const range: UsageRange = r === '24h' || r === '30d' || r === '90d' ? r : '7d';
    const tz = Number.parseInt(c.req.query('tz') ?? '0', 10);
    return c.json(usageReport(getSettings(), range, Number.isFinite(tz) ? tz : 0));
  });

  app.all('/api/*', () => {
    throw new HttpError(404, 'Not found');
  });

  // ----- Web client (website deployments) -----
  if (config.webDir) {
    const webDir = config.webDir;
    const indexHtml = path.join(webDir, 'index.html');
    app.use('/*', serveStatic({ root: webDir }));
    app.get('*', (c: Context) => c.html(fs.readFileSync(indexHtml, 'utf8')));
  }

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    console.error('[open-rock]', err);
    return c.json({ error: errorMessage(err) }, 500);
  });

  return app;
}
