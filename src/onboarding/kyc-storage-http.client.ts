/**
 * L3 adapter — the KYC document bucket (`payzeno-<env>-kyc-documents`, RFC platform-v2 §3).
 *
 * S3 over its HTTP API: localstack locally (`AWS_ENDPOINT_URL`, path-style addressing because
 * localstack does not serve virtual-hosted buckets on a bare hostname), the real regional
 * endpoint everywhere else. Built here rather than in `src/config/aws.config.ts` because this is
 * its only user and the bucket is not part of the bus; the credential rule is the same one
 * `aws.config.ts` applies — localstack wants some credentials and checks none.
 *
 * Objects are private and server-side encrypted. Nothing hands out a presigned URL: staff read
 * a document through `GET /v1/admin/merchants/:id/documents/:doc/content`, which is audited, and
 * a URL that works for fifteen minutes for whoever holds it is not.
 */
import { Readable } from 'node:stream';

import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { API_CONFIG, type ApiConfig } from '../config/api-config.type';

export interface StoredObject {
  body: Readable;
  contentType: string | null;
  contentLength: number | null;
}

@Injectable()
export class KycStorageClient implements OnApplicationShutdown {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    const options: S3ClientConfig = { region: config.aws.region };
    if (config.aws.endpointUrl) {
      options.endpoint = config.aws.endpointUrl;
      options.forcePathStyle = true;
      options.credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
    }
    this.s3 = new S3Client(options);
    this.bucket = config.kyc.documentsBucket;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async get(key: string): Promise<StoredObject> {
    const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!(result.Body instanceof Readable)) {
      throw new Error(`s3 returned no readable body for ${key}`);
    }
    return {
      body: result.Body,
      contentType: result.ContentType ?? null,
      contentLength: result.ContentLength ?? null,
    };
  }

  onApplicationShutdown(): void {
    this.s3.destroy();
  }
}
