import { Signer } from '@aws-sdk/rds-signer';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

export type PasswordSource =
  | { kind: 'static'; value: string }
  | { kind: 'env'; name: string }
  | { kind: 'aws-rds-iam'; region?: string };

export interface PasswordTarget { host: string; port: number; user: string }

/** pg's async `password` option: called for every new physical connection. */
export type PasswordProvider = () => Promise<string>;

export function passwordProvider(src: PasswordSource, target: PasswordTarget, env: NodeJS.ProcessEnv = process.env): PasswordProvider {
  switch (src.kind) {
    case 'static':
      return async () => src.value;
    case 'env':
      return async () => {
        const v = env[src.name];
        if (!v) throw new Error(`store password env var ${src.name} is not set`);
        return v;
      };
    case 'aws-rds-iam': {
      const region = src.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
      if (!region) throw new Error('aws-rds-iam needs a region (password.region or AWS_REGION)');
      // Signed for the exact configured hostname: an alias would not verify.
      // A token is minted per connection, so none outlives its 15-minute window.
      const signer = new Signer({
        hostname: target.host, port: target.port, username: target.user, region,
        credentials: fromNodeProviderChain(),
      });
      return () => signer.getAuthToken();
    }
  }
}
