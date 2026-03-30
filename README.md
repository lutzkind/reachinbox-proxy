# ReachInbox Proxy

A self-hosted transparent HTTP proxy that gives you full programmatic access to the [ReachInbox](https://app.reachinbox.ai) platform using your login credentials — no paid API key required.

## How It Works

The proxy forwards requests to `https://app.reachinbox.ai/api/v1/`, automatically injects your session token as a cookie, and normalizes a small set of legacy campaign routes so both the documented and currently working endpoint shapes keep working. When the token expires, it re-authenticates using your email/password and retries.

## Deployment

Deploy with [Coolify](https://coolify.io) or any Docker host:

```bash
docker build -t reachinbox-proxy .
docker run -p 3000:3000 \
  -e REACHINBOX_EMAIL=you@example.com \
  -e REACHINBOX_PASSWORD=yourpassword \
  reachinbox-proxy
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `REACHINBOX_EMAIL` | Yes | Your ReachInbox login email |
| `REACHINBOX_PASSWORD` | Yes | Your ReachInbox login password |
| `REACHINBOX_TOKEN` | No | Pre-captured JWT (skips login on startup) |
| `REACHINBOX_TOKEN_EXPIRY` | No | JWT expiry as Unix timestamp |
| `REACHINBOX_UPSTREAM_PROXY` | No | Optional upstream proxy for outbound ReachInbox requests |
| `PORT` | No | HTTP port (default: `3000`) |

---

## API Reference

All endpoints mirror the ReachInbox internal API. The proxy base URL replaces `https://app.reachinbox.ai`.

**Base URL:** `https://your-proxy-domain.com`

---

### Health

#### `GET /health`
Returns proxy status.

```json
{ "status": "ok", "service": "reachinbox-proxy" }
```

---

### Campaigns

Compatibility note: the proxy accepts both `/api/v1/campaign/*` and `/api/v1/campaigns/*` routes. For example, `/api/v1/campaigns/all` is normalized to `/api/v1/campaign/list`.

#### `GET /api/v1/campaign/list`
List all campaigns.

| Query Param | Type | Default | Description |
|---|---|---|---|
| `limit` | number | 50 | Max results |
| `filter` | string | `all` | Filter: `all`, `active`, `paused`, `completed` |
| `sort` | string | `newest` | Sort: `newest`, `oldest` |

#### `POST /api/v1/campaign/create`
Create a new campaign.

```json
{ "name": "My Campaign" }
```

#### `POST /api/v1/campaign/start`
Start a campaign.

```json
{ "campaignId": 12345 }
```

#### `POST /api/v1/campaign/pause`
Pause a campaign.

```json
{ "campaignId": 12345 }
```

#### `POST /api/v1/campaign/update`
Update campaign settings.

```json
{ "campaignId": 12345, "name": "New Name", "scheduleType": "CUSTOM" }
```

#### `POST /api/v1/campaign/analytics`
Get analytics for a specific campaign.

```json
{ "campaignId": 12345 }
```

#### `POST /api/v1/campaign/total-analytics`
Get aggregated analytics across campaigns.

| Query Param | Type | Description |
|---|---|---|
| `startDate` | string | ISO date string |
| `endDate` | string | ISO date string |

---

### Leads

#### `POST /api/v1/leads/add`
Add leads to a campaign.

```json
{
  "campaignId": 12345,
  "duplicates": "skip",
  "leads": [
    { "email": "lead@example.com", "firstName": "John", "lastName": "Doe" }
  ]
}
```

#### `POST /api/v1/leads/update`
Update a lead's data.

```json
{ "campaignId": 12345, "email": "lead@example.com", "firstName": "Jane" }
```

#### `POST /api/v1/leads/delete`
Delete leads from a campaign.

```json
{ "campaignId": 12345, "emails": ["lead@example.com"] }
```

---

### Lead Lists

#### `GET /api/v1/leads-list/all`
Get all lead lists.

| Query Param | Type | Default |
|---|---|---|
| `limit` | number | 50 |

#### `POST /api/v1/leads-list/create`
Create a new lead list.

```json
{ "name": "My List" }
```

#### `POST /api/v1/leads-list/add-leads`
Add leads to a list.

```json
{
  "listId": 11818,
  "leads": [{ "email": "lead@example.com" }]
}
```

---

### Email Accounts

#### `GET /api/v1/account/list`
Get all connected email accounts.

#### `GET /api/v1/account/warmup-analytics`
Get warmup analytics for email accounts.

---

### Onebox (Unified Inbox)

#### `POST /api/v1/onebox/list`
List inbox threads.

```json
{ "page": 1, "limit": 20 }
```

#### `POST /api/v1/onebox/send`
Send an email reply from inbox.

```json
{
  "threadId": "abc123",
  "body": "Thanks for reaching out!",
  "subject": "Re: Your inquiry"
}
```

#### `POST /api/v1/onebox/mark-all-read`
Mark all inbox messages as read.

#### `POST /api/v1/onebox/unread-count`
Get unread message count.

#### `POST /api/v1/onebox/liveInbox/unifiedSearch`
Search inbox threads.

```json
{ "query": "john doe", "page": 1 }
```

---

### Tags

#### `GET /api/v1/others/listAllTags`
Get all tags.

---

### Blocklist

#### `GET /api/v1/campaign/block-list`
Get blocklisted emails/domains.

#### `POST /api/v1/campaign/block-list/add`
Add to blocklist.

```json
{ "emails": ["spam@example.com"], "domains": ["spam.com"] }
```

---

### Webhooks

#### `GET /api/v1/webhook/list-all`
List all webhook subscriptions.

#### `POST /api/v1/webhook/subscribe`
Subscribe to webhook events.

```json
{
  "campaignId": 12345,
  "event": "REPLY_RECEIVED",
  "callbackUrl": "https://your-app.com/webhook",
  "allCampaigns": false
}
```

**Available events:** `ALL_EVENTS`, `EMAIL_SENT`, `EMAIL_OPENED`, `EMAIL_CLICKED`, `REPLY_RECEIVED`, `EMAIL_BOUNCED`, `LEAD_INTERESTED`, `LEAD_NOT_INTERESTED`, `CAMPAIGN_COMPLETED`

#### `POST /api/v1/webhook/unsubscribe`
Remove a webhook subscription.

```json
{
  "campaignId": 12345,
  "event": "REPLY_RECEIVED",
  "callbackUrl": "https://your-app.com/webhook"
}
```

---

## n8n Integration

Use the companion n8n community node package **`n8n-nodes-reachinbox-proxy`** to interact with this proxy from n8n workflows.

Set the credential **Proxy Base URL** to your deployed proxy URL (e.g. `https://reachinbox.luxeillum.com`).

---

## License

MIT
