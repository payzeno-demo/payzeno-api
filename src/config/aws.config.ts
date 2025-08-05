/**
 * AWS client construction for the bus (SNS out, SQS in) and KMS (webhook signing KEK).
 *
 * `AWS_ENDPOINT_URL` is set in docker-compose to localstack and unset in every deployed
 * environment; when it is unset the SDK resolves the real regional endpoint. Nothing else in
 * the repo constructs an AWS client.
 */
import { KMSClient } from '@aws-sdk/client-kms';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';

import type { ApiConfig } from './api-config.type';

export const SNS_CLIENT = Symbol('SNS_CLIENT');
export const SQS_CLIENT = Symbol('SQS_CLIENT');
export const KMS_CLIENT = Symbol('KMS_CLIENT');

interface BaseClientConfig {
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

function baseClientConfig(config: ApiConfig): BaseClientConfig {
  const base: BaseClientConfig = { region: config.aws.region };

  if (config.aws.endpointUrl) {
    base.endpoint = config.aws.endpointUrl;
    // localstack rejects anonymous requests but does not verify these.
    base.credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
  }

  return base;
}

export function createSnsClient(config: ApiConfig): SNSClient {
  return new SNSClient(baseClientConfig(config));
}

export function createSqsClient(config: ApiConfig): SQSClient {
  return new SQSClient(baseClientConfig(config));
}

export function createKmsClient(config: ApiConfig): KMSClient {
  return new KMSClient(baseClientConfig(config));
}

/** Topic for an event type. events.ts EVENT_TOPICS is the vocabulary; this is the ARN map. */
export function topicArnForEventType(config: ApiConfig, type: string): string {
  return type.startsWith('merchant.') ? config.aws.snsMerchantTopicArn : config.aws.snsPaymentsTopicArn;
}
