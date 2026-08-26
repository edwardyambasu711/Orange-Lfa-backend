# Orange League Backend

Fastify and MongoDB API for the Orange League dashboards.

## Requirements

- Node.js 22+
- MongoDB 7+

## Setup

From the backend repository root:

```bash
npm install
```

Set the environment variables below, then seed the local database:

```bash
npm run seed
npm run dev
```

## Environment

```env
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=orange_league
API_HOST=127.0.0.1
API_PORT=4000
FRONTEND_ORIGIN=http://localhost:5173
SESSION_SECRET=replace-with-at-least-32-characters
SESSION_TTL_DAYS=7
NODE_ENV=development
ADMIN_EMAIL=orange.admin@orangefirstdivision.com
ADMIN_PASSWORD=change-this-password
ADMIN_NAME=Orange League Admin
```

## Commands

```bash
npm run dev       # Start the API with tsx
npm run seed      # Create indexes and demo accounts
npm run build     # Typecheck the backend
npm test          # Run backend tests
```

The API is served under `/api/v1`. Health endpoints are `/health` and `/ready`.# Orange-Lfa-backend
