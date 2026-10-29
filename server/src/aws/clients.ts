import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { BedrockClient } from '@aws-sdk/client-bedrock';
import type { AwsSettings } from '@open-rock/shared';

/**
 * Bedrock clients authenticated with an Amazon Bedrock API key (bearer token).
 * The key comes from Settings, falling back to AWS_BEARER_TOKEN_BEDROCK in the environment.
 */

type AnyClient = BedrockRuntimeClient | BedrockClient;
const cache = new Map<string, AnyClient>();

export function bedrockApiKey(aws: AwsSettings): string {
  return aws.bedrockApiKey || process.env.AWS_BEARER_TOKEN_BEDROCK || '';
}

function auth(aws: AwsSettings) {
  const token = bedrockApiKey(aws);
  if (!token) throw new MissingKeyError();
  return {
    token: { token },
    authSchemePreference: ['httpBearerAuth'],
    // Never fall back to IAM credentials: the API key is the only sign-in.
    credentials: async () => {
      throw new MissingKeyError();
    },
  };
}

export class MissingKeyError extends Error {
  constructor() {
    super('Add your Amazon Bedrock API key in Settings → Variable.');
    this.name = 'MissingKeyError';
  }
}

function get<T extends AnyClient>(kind: string, aws: AwsSettings, region: string, make: () => T): T {
  const k = JSON.stringify([kind, region, bedrockApiKey(aws)]);
  let c = cache.get(k) as T | undefined;
  if (!c) {
    c = make();
    cache.set(k, c);
    if (cache.size > 12) {
      const first = cache.keys().next().value;
      if (first) cache.delete(first);
    }
  }
  return c;
}

export function runtimeClient(aws: AwsSettings, region = aws.region) {
  return get('runtime', aws, region, () => new BedrockRuntimeClient({ region, ...auth(aws), maxAttempts: 2 }));
}

export function bedrockClient(aws: AwsSettings, region = aws.region) {
  return get('bedrock', aws, region, () => new BedrockClient({ region, ...auth(aws) }));
}

/** Turn SDK errors into something a person can act on. */
export function friendlyAwsError(err: unknown): string {
  const e = err as { name?: string; message?: string };
  const name = e?.name ?? '';
  const msg = e?.message ?? String(err);
  if (name === 'MissingKeyError') return msg;
  if (name === 'UnrecognizedClientException' || name === 'InvalidSignatureException' || /bearer|api key|token.*(invalid|expired)/i.test(msg)) {
    return `Bedrock rejected the API key: ${msg} Check the key in Settings → Variable (short-term keys expire after 12 hours or less).`;
  }
  if (name === 'AccessDeniedException') {
    if (/model access|don't have access|not authorized to access this model|use case/i.test(msg)) {
      return `${msg} Make sure this model is enabled for your account in the Bedrock console, or pick another model.`;
    }
    return `Access denied: ${msg}`;
  }
  if (name === 'ResourceNotFoundException') return `Not found: ${msg}`;
  if (name === 'ThrottlingException' || name === 'TooManyRequestsException') return `Bedrock is throttling requests: ${msg} Try again shortly.`;
  if (name === 'ServiceQuotaExceededException') return `Quota exceeded: ${msg}`;
  if (name === 'ModelNotReadyException') return `The model isn't ready yet: ${msg}`;
  return msg;
}
