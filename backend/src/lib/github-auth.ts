import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';

dotenv.config();

const appId = process.env.GITHUB_APP_ID;
const privateKey = process.env.GITHUB_PRIVATE_KEY;

if (!appId || !privateKey) {
  console.warn(
    '⚠️  GITHUB_APP_ID or GITHUB_PRIVATE_KEY is not set. GitHub API calls will fail.'
  );
}

/**
 * Creates an authenticated Octokit instance for a GitHub App installation
 * @param installationId - The GitHub App installation ID
 * @returns Authenticated Octokit instance
 */
export async function createAuthenticatedOctokit(
  installationId: number
): Promise<Octokit> {
  if (!appId || !privateKey) {
    throw new Error(
      'GITHUB_APP_ID and GITHUB_PRIVATE_KEY must be configured'
    );
  }

  // Handle multiline private key (common in env vars)
  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');

  const auth = createAppAuth({
    appId,
    privateKey: formattedPrivateKey,
    installationId,
  });

  const octokit = new Octokit({
    authStrategy: auth,
    auth: {
      type: 'app',
      installationId,
    },
  });

  return octokit;
}

