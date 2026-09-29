import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  apiUrl: string;
}

/**
 * Creates one Octokit per GitHub App installation using the documented
 * authentication-strategy pattern: `authStrategy: createAppAuth` with
 * `auth: { appId, privateKey, installationId }`. Every request is then made
 * with an installation access token scoped to that installation only;
 * @octokit/auth-app caches the token and requests a new one before expiry.
 *
 * Clients are cached per installation so tokens are reused rather than
 * re-created for every call.
 */
export class GitHubClientFactory {
  private readonly clients = new Map<string, Octokit>();

  constructor(
    private readonly credentials: GitHubAppCredentials,
    private readonly options: { fetch?: typeof fetch; userAgent?: string } = {},
  ) {
    if (!credentials.appId || !credentials.privateKey) {
      throw new Error('GitHub App id and private key are required');
    }
  }

  get appId(): number {
    return Number(this.credentials.appId);
  }

  forInstallation(installationId: bigint | number): Octokit {
    const key = String(installationId);
    let client = this.clients.get(key);
    if (!client) {
      client = new Octokit({
        authStrategy: createAppAuth,
        auth: {
          appId: this.credentials.appId,
          // Tolerate single-line PEMs with literal "\n" escapes.
          privateKey: this.credentials.privateKey.replace(/\\n/g, '\n'),
          installationId: Number(installationId),
        },
        baseUrl: this.credentials.apiUrl,
        userAgent: this.options.userAgent ?? 'pr-risk-scorer',
        request: this.options.fetch ? { fetch: this.options.fetch } : undefined,
      });
      this.clients.set(key, client);
    }
    return client;
  }
}
