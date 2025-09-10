# QuickBooks MCP Server - Vercel Deployment Guide

This guide will help you deploy your QuickBooks MCP server to Vercel and use it with the Anthropic SDK.

## Prerequisites

1. **QuickBooks Developer Account**: You need a QuickBooks Developer account and an app with OAuth credentials.
2. **Vercel Account**: Sign up at [vercel.com](https://vercel.com)
3. **Vercel CLI** (optional): `npm i -g vercel`

## Step 1: Prepare Your QuickBooks App

1. Go to [QuickBooks Developer Dashboard](https://developer.intuit.com/app/developer/myapps)
2. Create a new app or use an existing one
3. Note down:
   - Client ID
   - Client Secret
   - Sandbox Company ID (Realm ID)
4. Set the redirect URI to: `https://your-app-name.vercel.app/callback` (you'll get the actual URL after deployment)

## Step 2: Deploy to Vercel

### Option A: Deploy via Vercel Dashboard (Recommended)

1. Push your code to GitHub/GitLab/Bitbucket
2. Go to [Vercel Dashboard](https://vercel.com/dashboard)
3. Click "New Project"
4. Import your repository
5. Configure environment variables in the Vercel dashboard:
   ```
   QB_CLIENT_ID=your_quickbooks_client_id
   QB_CLIENT_SECRET=your_quickbooks_client_secret
   QB_REALM_ID=your_quickbooks_realm_id
   REDIRECT_URI=https://your-app-name.vercel.app/callback
   ```
6. Deploy

### Option B: Deploy via CLI

1. Install Vercel CLI: `npm i -g vercel`
2. Login: `vercel login`
3. Deploy: `vercel`
4. Follow the prompts
5. Set environment variables: `vercel env add QB_CLIENT_ID`

## Step 3: Complete OAuth Authentication

1. After deployment, visit your Vercel app URL
2. You should see a status page showing `"authenticated": false`
3. Go to `https://your-app.vercel.app/callback?code=test` to trigger the OAuth flow
4. You'll be redirected to QuickBooks for authorization
5. After authorization, you'll see your access and refresh tokens
6. **Important**: Copy the tokens and add them as environment variables in Vercel:
   ```
   QB_ACCESS_TOKEN=your_access_token
   QB_REFRESH_TOKEN=your_refresh_token
   ```
7. Redeploy or wait for automatic redeployment

## Step 4: Test Your MCP Server

1. Visit `https://your-app.vercel.app/` - should show `"authenticated": true`
2. Test the SSE endpoint: `https://your-app.vercel.app/sse`

## Step 5: Use with Anthropic SDK

```javascript
import { Anthropic } from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: 'your-anthropic-api-key',
});

const response = await anthropic.beta.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1000,
  messages: [
    {
      role: "user",
      content: "What QuickBooks tools do you have available?",
    },
  ],
  mcp_servers: [
    {
      type: "url",
      url: "https://your-app.vercel.app/sse",
      name: "quickbooks-mcp",
      // Optional: Add authorization if needed
      // authorization_token: "your-token",
    },
  ],
  betas: ["mcp-client-2025-04-04"],
});

console.log(response.content);
```

## Available MCP Tools

Your deployed server provides these QuickBooks tools:

1. **get_customer_by_id** - Fetch a customer by ID
2. **list_customers** - List customers with pagination
3. **search_customers** - Search customers by name/email/phone
4. **create_customer** - Create a new customer
5. **update_customer** - Update an existing customer
6. **set_customer_active** - Activate/deactivate a customer
7. **get_customer_by_display_name** - Find customer by exact display name

## Troubleshooting

### Authentication Issues
- Make sure all environment variables are set in Vercel
- Check that your redirect URI matches exactly
- Verify your QuickBooks app is in development/production mode as needed

### Token Refresh
- The server automatically refreshes tokens when they expire
- In serverless environments, tokens are stored in memory and may need re-authentication on cold starts
- Consider implementing persistent token storage (database) for production use

### CORS Issues
- The SSE endpoint should handle CORS automatically
- If you encounter issues, you may need to add CORS middleware

### Cold Starts
- Vercel functions have cold starts that may cause initial delays
- Consider implementing a warming strategy if needed

## Production Considerations

1. **Token Storage**: Implement persistent storage for tokens (database, encrypted environment variables)
2. **Error Handling**: Add comprehensive error handling and logging
3. **Rate Limiting**: Implement rate limiting for the API endpoints
4. **Security**: Add authentication/authorization for your MCP endpoints if needed
5. **Monitoring**: Set up monitoring and alerting for your deployment

## Local Development

To test locally before deploying:

```bash
npm run dev
```

This starts the server in web mode on `http://localhost:3000` with the SSE endpoint at `http://localhost:3000/sse`.

## Environment Variables Reference

| Variable | Description | Required |
|----------|-------------|----------|
| `QB_CLIENT_ID` | QuickBooks app client ID | Yes |
| `QB_CLIENT_SECRET` | QuickBooks app client secret | Yes |
| `QB_REALM_ID` | QuickBooks company/realm ID | Yes |
| `QB_ACCESS_TOKEN` | OAuth access token (after auth) | Yes |
| `QB_REFRESH_TOKEN` | OAuth refresh token (after auth) | Yes |
| `REDIRECT_URI` | OAuth redirect URI | Yes |
| `VERCEL` | Set automatically by Vercel | Auto |
| `PORT` | Server port (Vercel sets this) | Auto | 