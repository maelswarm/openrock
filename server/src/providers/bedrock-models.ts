import {
  ListCustomModelDeploymentsCommand,
  ListFoundationModelsCommand,
  ListImportedModelsCommand,
  ListInferenceProfilesCommand,
  ListMarketplaceModelEndpointsCommand,
  ListProvisionedModelThroughputsCommand,
  type FoundationModelSummary,
  type InferenceProfileSummary,
} from '@aws-sdk/client-bedrock';
import { bedrockModelParams, stripProfilePrefix, type ModelCapabilities, type ModelInfo, type Settings } from '@open-rock/shared';
import { bedrockApiKey, bedrockClient } from '../aws/clients.js';

/** Models that produce text but don't work with the Converse chat API. */
const NON_CHAT = /(embed|rerank|sonic|canvas|reel|titan-image|stable-|sd3|marengo|-guard|pegasus-1-2-?audio)/i;

/** Imported-model architectures Converse can't run (they need InvokeModel); see Bedrock's Custom Model Import guide. */
const IMPORTED_WITHOUT_CONVERSE = /qwen|gpt.?oss/i;

const NO_SYSTEM_PROMPT = [/^amazon\.titan-text/, /^mistral\.mistral-7b/, /^mistral\.mixtral-8x7b/, /^cohere\.command-text/, /^cohere\.command-light/];

const NATIVE_DOCS = [
  /^anthropic\.claude-3/,
  /^anthropic\.claude-(sonnet|opus|haiku|fable|mythos)-\d/,
  /^anthropic\.claude-v2/,
  /^amazon\.nova-(pro|lite|premier|2)/,
  /^meta\.llama3/,
  /^meta\.llama4/,
  /^mistral\.mistral-large/,
  /^mistral\.pixtral/,
  /^cohere\.command-r/,
  /^ai21\.jamba/,
];

/** A best guess at image input for model IDs Bedrock's list doesn't describe (typed by hand or behind an ARN). */
const LIKELY_IMAGES = /claude-3|claude-(opus|sonnet|haiku|fable|mythos)-\d|nova-(pro|lite|premier|2)|llama3-2-(11|90)|llama4|pixtral|gemma-3-(4|12|27)b/;

export function capabilitiesFor(baseId: string, fm?: Pick<FoundationModelSummary, 'inputModalities' | 'responseStreamingSupported'>): ModelCapabilities {
  const inputs = fm?.inputModalities ?? ['TEXT'];
  const images = inputs.includes('IMAGE');
  const video = (inputs as string[]).includes('VIDEO');
  return {
    images,
    documents: NATIVE_DOCS.some((r) => r.test(baseId)),
    video,
    text: true,
    streaming: fm?.responseStreamingSupported ?? true,
    systemPrompt: !NO_SYSTEM_PROMPT.some((r) => r.test(baseId)),
    reasoning: bedrockModelParams(baseId).thinking !== null,
    maxImages: 20,
    maxDocuments: 5,
  };
}

function geoForRegion(region: string): string[] {
  if (region.startsWith('us-gov')) return ['us-gov'];
  if (region.startsWith('us-')) return ['us'];
  if (region.startsWith('eu-')) return ['eu'];
  if (region.startsWith('ca-')) return ['ca', 'us'];
  if (region === 'ap-northeast-1' || region === 'ap-northeast-3') return ['jp', 'apac'];
  if (region === 'ap-southeast-2' || region === 'ap-southeast-4') return ['au', 'apac'];
  if (region.startsWith('ap-')) return ['apac'];
  return [];
}

function scopeOf(profileId: string): string {
  return profileId.split('.')[0];
}

function pickProfile(profiles: InferenceProfileSummary[], region: string, pref: Settings['bedrock']['crossRegion']): InferenceProfileSummary | undefined {
  if (!profiles.length || pref === 'off') return undefined;
  const geo = geoForRegion(region);
  const byScope = (s: string) => profiles.find((p) => p.inferenceProfileId && scopeOf(p.inferenceProfileId) === s);
  const order = pref === 'global' ? ['global', ...geo] : pref === 'geo' ? [...geo, 'global'] : [...geo, 'global'];
  for (const s of order) {
    const p = byScope(s);
    if (p) return p;
  }
  return profiles[0];
}

function prettyProvider(p?: string): string {
  if (!p) return 'Other';
  return p;
}

interface CacheEntry {
  at: number;
  key: string;
  models: ModelInfo[];
}
let cache: CacheEntry | null = null;
const TTL = 10 * 60 * 1000;

export function invalidateModelCache() {
  cache = null;
}

async function listProfiles(settings: Settings, type: 'SYSTEM_DEFINED' | 'APPLICATION'): Promise<InferenceProfileSummary[]> {
  const client = bedrockClient(settings.aws);
  const out: InferenceProfileSummary[] = [];
  let nextToken: string | undefined;
  for (let i = 0; i < 20; i++) {
    const res = await client.send(new ListInferenceProfilesCommand({ maxResults: 1000, nextToken, typeEquals: type }));
    out.push(...(res.inferenceProfileSummaries ?? []));
    nextToken = res.nextToken;
    if (!nextToken) break;
  }
  return out;
}

function modelIdFromArn(arn?: string): string {
  // arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-…
  if (!arn) return '';
  const i = arn.indexOf('foundation-model/');
  return i >= 0 ? arn.slice(i + 'foundation-model/'.length) : '';
}

/**
 * Models you've set up yourself: provisioned throughput, custom model deployments, imported models and Bedrock
 * Marketplace endpoints (where most Gemma variants live). Each list needs its own permission; any that can't be read is
 * left out.
 */
async function listOwnModels(settings: Settings, fmById: Map<string, FoundationModelSummary>): Promise<ModelInfo[]> {
  const client = bedrockClient(settings.aws);
  const none = () => undefined;
  const [provisioned, deployments, imported, marketplace] = await Promise.all([
    client.send(new ListProvisionedModelThroughputsCommand({ maxResults: 1000 })).catch(none),
    client.send(new ListCustomModelDeploymentsCommand({ maxResults: 1000 })).catch(none),
    client.send(new ListImportedModelsCommand({ maxResults: 1000 })).catch(none),
    client.send(new ListMarketplaceModelEndpointsCommand({ maxResults: 1000 })).catch(none),
  ]);
  const out: ModelInfo[] = [];
  const add = (id: string | undefined, name: string | undefined, provider: string, base: string) => {
    if (!id) return;
    const fm = fmById.get(base);
    out.push({
      id,
      baseId: base || id,
      name: name || id,
      provider,
      mode: 'bedrock',
      custom: true,
      capabilities: fm ? capabilitiesFor(base, fm) : { ...capabilitiesFor(base), images: LIKELY_IMAGES.test(base) },
    });
  };
  for (const p of provisioned?.provisionedModelSummaries ?? []) {
    if (p.status === 'Failed') continue;
    add(p.provisionedModelArn, p.provisionedModelName, 'Provisioned throughput', modelIdFromArn(p.foundationModelArn) || modelIdFromArn(p.modelArn));
  }
  for (const d of deployments?.modelDeploymentSummaries ?? []) {
    if (d.status !== 'Active') continue;
    add(d.customModelDeploymentArn, d.customModelDeploymentName, 'Custom models', d.modelArn ?? '');
  }
  for (const m of imported?.modelSummaries ?? []) {
    if (IMPORTED_WITHOUT_CONVERSE.test(m.modelArchitecture ?? '')) continue;
    add(m.modelArn, m.modelName, 'Imported models', m.modelArn ?? '');
  }
  for (const e of marketplace?.marketplaceModelEndpoints ?? []) {
    if (e.status === 'INCOMPATIBLE_ENDPOINT') continue;
    // arn:aws:sagemaker:…:hub-content/SageMakerPublicHub/Model/huggingface-vlm-gemma-3-27b-instruct/1.0.0
    const source = e.modelSourceIdentifier?.split('/').at(-2) ?? '';
    const endpoint = e.endpointArn?.split('/').at(-1) ?? '';
    add(e.endpointArn, source && endpoint ? `${source} (${endpoint})` : source || endpoint, 'Marketplace', source);
  }
  return out;
}

export async function listBedrockModels(settings: Settings, force = false): Promise<ModelInfo[]> {
  const region = settings.aws.region;
  const k = JSON.stringify([region, bedrockApiKey(settings.aws).slice(-6), settings.bedrock.crossRegion]);
  if (!force && cache && cache.key === k && Date.now() - cache.at < TTL) return withCustom(cache.models, settings);

  const client = bedrockClient(settings.aws);
  const [fmRes, sysProfiles, appProfiles] = await Promise.all([
    client.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' })),
    listProfiles(settings, 'SYSTEM_DEFINED').catch(() => [] as InferenceProfileSummary[]),
    listProfiles(settings, 'APPLICATION').catch(() => [] as InferenceProfileSummary[]),
  ]);

  const profilesByModel = new Map<string, InferenceProfileSummary[]>();
  for (const p of sysProfiles) {
    const ids = new Set((p.models ?? []).map((m) => modelIdFromArn(m.modelArn)).filter(Boolean));
    if (!ids.size && p.inferenceProfileId) ids.add(stripProfilePrefix(p.inferenceProfileId));
    for (const id of ids) {
      const list = profilesByModel.get(id) ?? [];
      list.push(p);
      profilesByModel.set(id, list);
    }
  }

  const fmById = new Map<string, FoundationModelSummary>();
  const models: ModelInfo[] = [];
  for (const fm of fmRes.modelSummaries ?? []) {
    const id = fm.modelId;
    if (!id) continue;
    fmById.set(id, fm);
    if (NON_CHAT.test(id)) continue;
    if (!(fm.outputModalities ?? []).includes('TEXT')) continue;
    const types = fm.inferenceTypesSupported ?? [];
    const profile = pickProfile(profilesByModel.get(id) ?? [], region, settings.bedrock.crossRegion);
    const onDemand = types.includes('ON_DEMAND');
    // Prefer on-demand in-region unless the user asked for cross-region routing.
    let invokeId: string | undefined;
    let scope: string | undefined;
    if (profile && (!onDemand || settings.bedrock.crossRegion === 'global' || settings.bedrock.crossRegion === 'geo')) {
      invokeId = profile.inferenceProfileId;
      scope = invokeId ? scopeOf(invokeId) : undefined;
    } else if (onDemand) {
      invokeId = id;
    } else if (profile) {
      invokeId = profile.inferenceProfileId;
      scope = invokeId ? scopeOf(invokeId) : undefined;
    } else if ((types as string[]).includes('INFERENCE_PROFILE') && settings.bedrock.crossRegion !== 'off') {
      // The profile list wasn't readable (or is missing this model): use the standard geographic profile ID.
      scope = settings.bedrock.crossRegion === 'global' ? 'global' : geoForRegion(region)[0] ?? 'us';
      invokeId = `${scope}.${id}`;
    }
    if (!invokeId) continue; // provisioned-only variants such as ":28k"; usable through provisioned throughput below
    // Legacy models still work until their end-of-life date, so they're listed (and tagged) like the rest.
    const legacy = fm.modelLifecycle?.status === 'LEGACY';
    models.push({
      id: invokeId,
      baseId: id,
      name: fm.modelName ?? id,
      provider: prettyProvider(fm.providerName),
      mode: 'bedrock',
      legacy,
      endOfLife: legacy ? fm.modelLifecycle?.endOfLifeTime?.getTime() : undefined,
      profileScope: scope,
      capabilities: capabilitiesFor(id, fm),
    });
  }

  for (const p of appProfiles) {
    if (!p.inferenceProfileArn) continue;
    const base = modelIdFromArn(p.models?.[0]?.modelArn);
    const fm = fmById.get(base);
    models.push({
      id: p.inferenceProfileArn,
      baseId: base || p.inferenceProfileArn,
      name: p.inferenceProfileName ?? p.inferenceProfileArn,
      provider: 'Application profiles',
      mode: 'bedrock',
      custom: true,
      capabilities: capabilitiesFor(base, fm),
    });
  }

  models.push(...(await listOwnModels(settings, fmById)));
  // Within a provider, models still being developed come before legacy ones.
  models.sort((a, b) => a.provider.localeCompare(b.provider) || Number(!!a.legacy) - Number(!!b.legacy) || a.name.localeCompare(b.name));
  cache = { at: Date.now(), key: k, models };
  return withCustom(models, settings);
}

function withCustom(models: ModelInfo[], settings: Settings): ModelInfo[] {
  return [...customModelInfos(settings), ...models];
}

/** The user's own model IDs from Settings, usable even when Bedrock's model list can't be read. */
export function customModelInfos(settings: Settings): ModelInfo[] {
  return settings.bedrock.customModels
    .filter((m) => m.id.trim())
    .map((m) => {
      const base = stripProfilePrefix(m.id.trim());
      const caps = capabilitiesFor(base);
      return {
        id: m.id.trim(),
        baseId: base,
        name: m.name || m.id,
        provider: 'Custom',
        mode: 'bedrock' as const,
        custom: true,
        capabilities: { ...caps, images: m.images, documents: m.documents, video: m.video },
      };
    });
}

/** Capabilities for a model ID that may not be in the list (e.g. typed by hand). */
export async function resolveBedrockModel(settings: Settings, modelId: string): Promise<ModelInfo> {
  try {
    const list = await listBedrockModels(settings);
    const hit = list.find((m) => m.id === modelId) ?? list.find((m) => m.baseId === modelId);
    if (hit) return hit;
  } catch {
    // Listing needs bedrock:ListFoundationModels; chatting doesn't. Fall through to a best guess.
  }
  const base = stripProfilePrefix(modelId);
  return {
    id: modelId,
    baseId: base,
    name: modelId,
    provider: 'Bedrock',
    mode: 'bedrock',
    capabilities: { ...capabilitiesFor(base), images: LIKELY_IMAGES.test(base) },
  };
}
