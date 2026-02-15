# Backend API

Fastify-based backend server for PR Risk Scorer with GitHub webhook integration.

## Features

- Fastify server with TypeScript
- Structured logging with request IDs
- GitHub webhook handling with signature verification
- BullMQ job queue with Redis for async processing
- Worker process for background job processing
- Error handling with consistent JSON responses
- Zod validation utilities

## Quick Start

### Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0

### Installation

```bash
pnpm install
```

### Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

Required variables:
- `PORT` - Server port (default: 4000)
- `GITHUB_WEBHOOK_SECRET` - GitHub webhook secret for signature verification
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string

### Development

The backend consists of two processes that need to run concurrently:

1. **Server** - Handles HTTP requests and webhooks
2. **Worker** - Processes background jobs from the queue

#### Running Server and Worker

**Option 1: Separate Terminals (Recommended)**

Terminal 1 - Server:
```bash
pnpm dev
```

Terminal 2 - Worker:
```bash
pnpm worker
```

**Option 2: Using a Process Manager**

You can use tools like `concurrently` or `pm2` to run both processes together.

Server runs on http://localhost:4000

#### Architecture

```
GitHub Webhook → Server (Fastify) → Redis Queue → Worker → Process Job
                     ↓
                 200 OK (<100ms)
```

When a webhook is received:
1. Server verifies the signature
2. Server enqueues a `score_pr` job to Redis
3. Server responds with 200 OK immediately (<100ms)
4. Worker picks up the job and processes it asynchronously

## API Endpoints

### Health Check

```bash
GET /health
```

Returns: `{ ok: true }`

### Version

```bash
GET /api/version
```

Returns: `{ version: "1.0.0" }`

### GitHub Webhook

```bash
POST /webhooks/github
```

Accepts GitHub webhook payloads with signature verification. After verification, enqueues a `score_pr` job and responds immediately with 200 OK.

**Job Queue Flow:**
1. Webhook received and signature verified
2. Job enqueued to `score_pr` queue with:
   - Repository owner and name
   - Pull request number
   - Installation ID (if present)
   - Delivery ID
3. Response sent immediately (<100ms)
4. Worker processes job asynchronously

### List Pull Requests

```bash
GET /api/prs?limit=50&offset=0
```

**Query Parameters:**
- `limit` (optional, default: 50, max: 100) - Number of PRs to return
- `offset` (optional, default: 0) - Pagination offset

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "github_pr_id": 123,
      "title": "PR title",
      "author": "username",
      "state": "open",
      "repository": "owner/repo",
      "additions": 100,
      "deletions": 50,
      "changed_files": 5,
      "created_at": "2024-01-01T00:00:00Z",
      "latest_score": {
        "score": 45.5,
        "level": "medium",
        "reasons": ["reason1", "reason2"],
        "created_at": "2024-01-01T00:00:00Z"
      }
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 150,
    "has_more": true
  }
}
```

**Example:**
```bash
curl http://localhost:4000/api/prs?limit=50
```

### Get PR Details

```bash
GET /api/prs/:id
```

**Path Parameters:**
- `id` - PR UUID

**Response:**
```json
{
  "id": "uuid",
  "github_pr_id": 123,
  "title": "PR title",
  "author": "username",
  "state": "open",
  "repository": "owner/repo",
  "additions": 100,
  "deletions": 50,
  "changed_files": 5,
  "changed_files_list": ["file1.ts", "file2.ts"],
  "head_sha": "abc123",
  "base_ref": "main",
  "head_ref": "feature/branch",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-01T00:00:00Z",
  "merged_at": null,
  "latest_score": {
    "score": 45.5,
    "level": "medium",
    "reasons": ["reason1", "reason2"],
    "features": {...},
    "created_at": "2024-01-01T00:00:00Z"
  },
  "score_history": [
    {
      "score": 45.5,
      "level": "medium",
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

**Example:**
```bash
curl http://localhost:4000/api/prs/123e4567-e89b-12d3-a456-426614174000
```

### Get Statistics

```bash
GET /api/stats
```

**Response:**
```json
{
  "total_prs": 150,
  "average_score": 42.5,
  "counts_by_level": {
    "low": 50,
    "medium": 70,
    "high": 30
  },
  "top_risky_folders": [
    {
      "folder": "src/auth",
      "pr_count": 15,
      "average_score": 65.2
    },
    {
      "folder": "src/payments",
      "pr_count": 12,
      "average_score": 58.3
    }
  ]
}
```

**Example:**
```bash
curl http://localhost:4000/api/stats
```

## GitHub App Setup

This guide explains how to create a GitHub App and configure webhooks for local development and production.

### Step 1: Create a GitHub App

1. Go to your GitHub organization or personal account settings
2. Navigate to **Developer settings** → **GitHub Apps**
3. Click **New GitHub App**
4. Fill in the app details:
   - **GitHub App name**: `PR Risk Scorer` (or your preferred name)
   - **Homepage URL**: Your application URL
   - **Webhook URL**: 
     - For local dev: Use ngrok (see Step 2)
     - For production: Your production webhook URL (e.g., `https://api.yourdomain.com/webhooks/github`)
   - **Webhook secret**: Generate a strong random string (save this!)
5. Set **Permissions & events**:
   - Under **Repository permissions**:
     - **Pull requests**: Read-only (required for fetching PR details)
     - **Contents**: Read-only (required for fetching PR file diffs for AI analysis)
     - **Issues**: Write (required for posting AI analysis comments on PRs)
   - Under **Subscribe to events**:
     - Check **Pull request**
6. Click **Create GitHub App**

### Step 2: Get Webhook Secret

1. After creating the app, you'll see the app settings page
2. Scroll down to **Webhook** section
3. Copy the **Webhook secret** (or generate a new one)
4. Add it to your `.env` file:
   ```
   GITHUB_WEBHOOK_SECRET=your_secret_here
   ```

### Step 3: Local Development Setup

For local development, you need to expose your local server to the internet so GitHub can send webhooks.

#### Option A: Using ngrok (Recommended)

1. Install ngrok: https://ngrok.com/download
2. Start your backend server:
   ```bash
   pnpm dev
   ```
3. In another terminal, expose port 4000:
   ```bash
   ngrok http 4000
   ```
4. Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)
5. Update your GitHub App webhook URL:
   - Go to your GitHub App settings
   - Update **Webhook URL** to: `https://abc123.ngrok.io/webhooks/github`
   - Save changes

#### Option B: Using GitHub CLI (gh)

```bash
gh auth login
gh api repos/:owner/:repo/hooks --method POST \
  --field name=web \
  --field config[url]=https://your-ngrok-url.ngrok.io/webhooks/github \
  --field config[content_type]=json \
  --field config[secret]=your_webhook_secret
```

### Step 4: Production Setup

1. Deploy your backend to a server with a public URL
2. Update your GitHub App webhook URL:
   - Go to your GitHub App settings
   - Update **Webhook URL** to: `https://api.yourdomain.com/webhooks/github`
   - Ensure the webhook secret matches your production environment variable
   - Save changes

### Step 5: Install the GitHub App

1. Go to your GitHub App settings
2. Click **Install App**
3. Choose which repositories to install the app on:
   - **Only select repositories**: Choose specific repos
   - **All repositories**: Install on all repos (use with caution)
4. Click **Install**

## Testing Webhooks

### Using GitHub's Webhook Testing

1. Go to your GitHub App settings
2. Scroll to **Recent Deliveries**
3. Click on a delivery to see details
4. Click **Redeliver** to resend a webhook

### Using curl (for testing)

Create a test payload file `test-webhook.json`:

```json
{
  "action": "opened",
  "pull_request": {
    "number": 123
  },
  "repository": {
    "full_name": "owner/repo"
  },
  "sender": {
    "login": "username"
  }
}
```

Generate a signature (requires the webhook secret):

```bash
# On macOS/Linux
echo -n "$(cat test-webhook.json)" | openssl dgst -sha256 -hmac "your_webhook_secret" | sed 's/^.* //'

# The signature should be prefixed with 'sha256='
```

Send the webhook:

```bash
curl -X POST http://localhost:4000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: test-delivery-id" \
  -H "X-Hub-Signature-256: sha256=your_generated_signature" \
  -d @test-webhook.json
```

### Using GitHub CLI

```bash
gh api repos/:owner/:repo/hooks/:hook_id/tests \
  --method POST \
  -H "Accept: application/vnd.github.v3+json"
```

## Webhook Events

The backend currently handles the following events:

### Pull Request Events

- **`opened`**: When a pull request is opened
- **`synchronize`**: When new commits are pushed to a pull request

Other events are accepted but ignored (logged at debug level).

## Logging

All webhook events are logged with structured logging including:
- Request ID
- Event type
- Action
- Repository full name
- Pull request number
- Sender login

Example log output:
```json
{
  "requestId": "abc-123-def",
  "event": "pull_request",
  "action": "opened",
  "repository": "owner/repo",
  "prNumber": 123,
  "sender": "username"
}
```

## Error Handling

The webhook endpoint returns consistent error responses:

- **401 Unauthorized**: Invalid or missing signature
- **400 Bad Request**: Invalid JSON payload
- **500 Internal Server Error**: Server configuration error

All errors include a request ID for tracing.

## Security

- Webhook signatures are verified using HMAC-SHA256
- Invalid signatures are rejected with 401 status
- Webhook secret must be kept secure and never committed to version control
- Use environment variables for all secrets

## Troubleshooting

### Webhook signature verification fails

1. Verify `GITHUB_WEBHOOK_SECRET` matches the secret in GitHub App settings
2. Ensure the raw body is being received (check logs)
3. Verify the signature header format: `sha256=...`

### Webhooks not received locally

1. Ensure ngrok is running and forwarding to port 4000
2. Verify the GitHub App webhook URL matches your ngrok URL
3. Check ngrok web interface for incoming requests

### Webhooks received but not processed

1. Check server logs for event type and action
2. Verify the event type is `pull_request`
3. Verify the action is `opened` or `synchronize`
4. Check that the payload structure matches expected format

## Development

### Project Structure

```
backend/
├── src/
│   ├── index.ts              # Main server entry point
│   ├── worker.ts              # Worker process entry point
│   ├── config/
│   │   └── constants.ts      # App constants (version)
│   ├── lib/
│   │   ├── prisma.ts         # Prisma Client singleton
│   │   └── queue.ts          # BullMQ queue setup
│   ├── plugins/
│   │   ├── request-id.ts     # Request ID plugin
│   │   └── error-handler.ts  # Error handling plugin
│   ├── routes/
│   │   ├── health.ts         # Health check route
│   │   ├── version.ts        # Version route
│   │   └── webhooks.ts       # GitHub webhook route
│   ├── services/
│   │   └── github-webhook.ts # Webhook processing service
│   └── utils/
│       └── validation.ts     # Zod validation utilities
```

### Building

```bash
pnpm build
```

### Production

**Server:**
```bash
pnpm start
```

**Worker:**
```bash
pnpm start:worker
```

Both processes should run concurrently in production. Use a process manager like PM2 or systemd to manage them.

## License

Private

