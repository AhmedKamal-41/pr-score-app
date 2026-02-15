# PR Risk Scorer

[![Backend CI](https://github.com/{owner}/{repo}/actions/workflows/backend-ci.yml/badge.svg)](https://github.com/{owner}/{repo}/actions/workflows/backend-ci.yml)
[![Frontend CI](https://github.com/{owner}/{repo}/actions/workflows/frontend-ci.yml/badge.svg)](https://github.com/{owner}/{repo}/actions/workflows/frontend-ci.yml)

A production-ready monorepo with Fastify backend and Next.js frontend, powered by pnpm workspaces.

## Architecture

- **Backend**: Fastify + TypeScript (Port 4000)
- **Frontend**: Next.js 14 + TypeScript + Tailwind CSS (Port 3000)
- **Database**: PostgreSQL (Port 5432)
- **Cache**: Redis (Port 6379)

## CI/CD

This project uses GitHub Actions for continuous integration. CI runs automatically on:
- All pull requests
- Pushes to the `main` branch

### Backend CI
- Lint (ESLint)
- Typecheck (TypeScript)
- Tests (Vitest)
- Test coverage reports uploaded as artifacts

### Frontend CI
- Lint (Next.js ESLint)
- Typecheck (TypeScript)
- Build (Next.js production build)
- Build artifacts uploaded for deployment

**Note**: Update the CI badges in README.md with your GitHub repository owner and name (replace `{owner}` and `{repo}`).

## Prerequisites

- Node.js >= 18.0.0
- pnpm >= 8.0.0
- Docker and Docker Compose

## Quickstart

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Start Docker Services

Start PostgreSQL and Redis using Docker Compose:

```bash
docker-compose up -d
```

Verify services are running:

```bash
docker-compose ps
```

### 3. Configure Environment Variables

Copy the example environment files and configure them:

**Backend:**
```bash
cp backend/.env.example backend/.env
```

**Frontend:**
```bash
cp frontend/.env.example frontend/.env
```

Edit the `.env` files if you need to change any default values.

### 4. Start Development Servers

Run both backend and frontend concurrently:

```bash
pnpm dev
```

This will start:
- Backend server at http://localhost:4000
- Frontend application at http://localhost:3000

### 5. Verify Everything Works

- Open http://localhost:3000 in your browser
- Check backend health: http://localhost:4000/health

## Local Webhook Dev

For testing GitHub webhooks locally, use Smee.io to forward webhooks to your local server.

### 1. Install Smee CLI

```bash
npm install -g smee-client
```

### 2. Create Smee Channel

1. Visit https://smee.io
2. Click **"Start a new channel"**
3. Copy the webhook URL (e.g., `https://smee.io/abc123`)

### 3. Start Smee Forwarding

In a separate terminal, start Smee to forward webhooks to your local server:

```bash
smee -u https://smee.io/abc123 --target http://localhost:4000/webhooks/github
```

Keep this terminal running while testing webhooks.

### 4. Configure Backend

Add the Smee URL to your `backend/.env`:

```bash
WEBHOOK_PROXY_URL=https://smee.io/abc123
```

### 5. Update GitHub App

1. Go to your GitHub App settings
2. Update the **Webhook URL** to your Smee URL: `https://smee.io/abc123`
3. Save changes

### Testing

1. Start the backend: `pnpm --filter backend dev`
2. Start Smee forwarding (step 3 above)
3. Create or update a pull request in a repository where your GitHub App is installed
4. Check backend logs to see the webhook event

The backend startup message will remind you of the webhook URL to use in your GitHub App settings.

## Project Structure

```
pr-risk-scorer/
├── backend/          # Fastify API server
├── frontend/         # Next.js application
├── docker-compose.yml
└── package.json      # Root workspace config
```

## Available Scripts

### Root Level

- `pnpm dev` - Start both backend and frontend in development mode
- `pnpm build` - Build all packages
- `pnpm lint` - Lint all packages

### Backend

- `pnpm --filter backend dev` - Start backend dev server
- `pnpm --filter backend build` - Build backend
- `pnpm --filter backend start` - Start production server

### Frontend

- `pnpm --filter frontend dev` - Start frontend dev server
- `pnpm --filter frontend build` - Build frontend
- `pnpm --filter frontend start` - Start production server

## Docker Services

### Stop Services

```bash
docker-compose down
```

### Stop and Remove Volumes

```bash
docker-compose down -v
```

### View Logs

```bash
docker-compose logs -f
```

## Environment Variables

### Backend (.env)

- `PORT` - Server port (default: 4000)
- `NODE_ENV` - Environment (development/production)
- `DATABASE_URL` - PostgreSQL connection string
- `REDIS_URL` - Redis connection string
- `FRONTEND_URL` - Frontend URL for CORS (default: http://localhost:3000)
- `WEBHOOK_PROXY_URL` - Smee.io webhook proxy URL for local development (optional)
- `GITHUB_WEBHOOK_SECRET` - GitHub webhook secret for signature verification

### Frontend (.env)

- `NEXT_PUBLIC_API_URL` - Backend API URL (default: http://localhost:4000)

## Development

The monorepo uses pnpm workspaces for dependency management. All shared dependencies are hoisted to the root `node_modules` directory.

Hot reload is enabled for both backend (using `tsx watch`) and frontend (using Next.js built-in hot reload).

## License

Private

