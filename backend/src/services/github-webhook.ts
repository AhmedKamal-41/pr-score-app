import { FastifyInstance } from 'fastify';
import requestContext from '@fastify/request-context';

interface PullRequestPayload {
  action: string;
  pull_request: {
    number: number;
  };
  repository: {
    full_name: string;
  };
  sender: {
    login: string;
  };
}

const SUPPORTED_ACTIONS = ['opened', 'synchronize'] as const;

export function processPullRequestEvent(
  fastify: FastifyInstance,
  payload: PullRequestPayload
): void {
  const requestId = requestContext.get('requestId') || 'unknown';
  const { action, pull_request, repository, sender } = payload;

  // Only process supported actions
  if (!SUPPORTED_ACTIONS.includes(action as typeof SUPPORTED_ACTIONS[number])) {
    fastify.log.debug(
      {
        requestId,
        event: 'pull_request',
        action,
        repository: repository.full_name,
        prNumber: pull_request.number,
      },
      'Ignoring unsupported pull_request action'
    );
    return;
  }

  // Log the pull request event details
  fastify.log.info(
    {
      requestId,
      event: 'pull_request',
      action,
      repository: repository.full_name,
      prNumber: pull_request.number,
      sender: sender.login,
    },
    'Pull request event received'
  );
}

