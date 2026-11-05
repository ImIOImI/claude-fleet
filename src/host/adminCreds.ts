// Where `fleet-host bootstrap` gets the admin credential. Memory only; errors name sources and fields, never values.
import { readFile } from 'node:fs/promises';
import { passwordProvider } from '../main/store/passwordProvider.js';

export type AdminSource =
  | { kind: 'secret'; arn: string; userField: string; passwordField: string; region?: string; user?: string }
  | { kind: 'file'; path: string; user: string }
  | { kind: 'env'; name: string; user: string }
  | { kind: 'aws-rds-iam'; user: string; region?: string };

export interface AdminCredential {
  user: string;
  password: string | (() => Promise<string>);
  /** Values to scrub from output; aws-rds-iam tokens are added as they are minted. */
  secrets: string[];
}

export type GetSecretString = (arn: string, region: string) => Promise<string>;

export class AdminCredentialError extends Error {}

const SECRET_ARN = /^arn:aws[a-z-]*:secretsmanager:([a-z]{2}(?:-[a-z]+)+-\d+):\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/;

/** The AWS SDK default chain (Pod Identity, IRSA, env, profile). */
export const awsGetSecret: GetSecretString = async (arn, region) => {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region });
  try {
    const out = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (typeof out.SecretString !== 'string') throw new AdminCredentialError('admin secret has no SecretString (binary secrets are not supported)');
    return out.SecretString;
  } finally {
    client.destroy();
  }
};

export interface ResolveDeps {
  env: NodeJS.ProcessEnv;
  getSecret: GetSecretString;
  readFile?: (path: string) => Promise<string>;
  /** The admin connection's endpoint: aws-rds-iam tokens are signed for it. */
  target: { host: string; port: number };
}

export async function resolveAdminCredential(src: AdminSource, d: ResolveDeps): Promise<AdminCredential> {
  switch (src.kind) {
    case 'secret': {
      const m = SECRET_ARN.exec(src.arn);
      if (!m) throw new AdminCredentialError('--admin-secret-arn is not a Secrets Manager secret ARN');
      const raw = await d.getSecret(src.arn, src.region ?? m[1]);
      let obj: unknown = null;
      try {
        obj = JSON.parse(raw);
      } catch {
        // JSON.parse's message quotes the input.
      }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new AdminCredentialError('admin secret is not a JSON object');
      const field = (f: string): string => {
        const v = (obj as Record<string, unknown>)[f];
        if (typeof v !== 'string' || !v) throw new AdminCredentialError(`admin secret has no non-empty string field "${f}"`);
        return v;
      };
      const password = field(src.passwordField);
      return { user: src.user ?? field(src.userField), password, secrets: [password, raw] };
    }
    case 'file': {
      let text: string;
      try {
        text = await (d.readFile ?? ((p: string) => readFile(p, 'utf8')))(src.path);
      } catch (e) {
        throw new AdminCredentialError(`cannot read --admin-password-file: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
      }
      const password = text.replace(/\r?\n$/, '');
      if (!password) throw new AdminCredentialError('--admin-password-file is empty');
      return { user: src.user, password, secrets: [password] };
    }
    case 'env': {
      const password = d.env[src.name];
      if (!password) throw new AdminCredentialError(`admin password env var ${src.name} is not set`);
      return { user: src.user, password, secrets: [password] };
    }
    case 'aws-rds-iam': {
      const mint = passwordProvider({ kind: 'aws-rds-iam', region: src.region }, { ...d.target, user: src.user }, d.env);
      const secrets: string[] = [];
      return {
        user: src.user,
        password: async () => {
          const t = await mint();
          secrets.push(t);
          return t;
        },
        secrets
      };
    }
  }
}
