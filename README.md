# Nostr Order Bridge

Invite-only merchant registration portal for the Bitcoin Butlers Nostr ↔ WooCommerce bridge.

## What It Does

Provides a web interface at `nostr.bitcoinbutlers.com` where WooCommerce merchants register their store to receive orders from the Nostr marketplace.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Merchant visits │────▶│  nostr-bridge     │────▶│  nostr-listener     │
│  invite link     │     │  (registration)   │     │  (watches relays)   │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
```

## Architecture

Three services work together on the same droplet:

| Service | Port | Purpose |
|---------|------|---------|
| **nostr-listener** | 3847 | Watches Nostr relays, forwards orders to merchant webhooks |
| **nostr-bridge** | 3848 | Invite system + registration form for merchants |
| **nginx** | 443 | SSL termination, proxies to bridge |

## Flow

### For the operator (Kiwi):
1. Generate invite link via API
2. Send to friend (merchant)

### For the merchant:
1. Install `woo-nostr-market` plugin on WordPress (download from bridge)
2. Configure Nostr keys (via Alby/nos2x browser extension)
3. Publish stall + sync products to Nostr relays
4. Open invite link → enter store name, npub, WooCommerce URL, email
5. Receive webhook URL + secret → paste into plugin settings
6. Done — Nostr orders flow into their WooCommerce

## Deployment

```bash
# Clone and build
git clone https://github.com/RenAndKiwi/nostr-order-bridge.git
cd nostr-order-bridge
docker build -t nostr-bridge .

# Run (same box as nostr-listener)
docker run -d --name nostr-bridge \
  --restart unless-stopped \
  -p 127.0.0.1:3848:3848 \
  -e LISTENER_URL=http://127.0.0.1:3847 \
  -e LISTENER_TOKEN=your-listener-admin-token \
  nostr-bridge
```

### Nginx + SSL

```bash
# Point nginx to bridge
cat > /etc/nginx/sites-available/nostr-bridge << 'EOF'
server {
    listen 80;
    server_name nostr.bitcoinbutlers.com;
    location / {
        proxy_pass http://127.0.0.1:3848;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
ln -sf /etc/nginx/sites-available/nostr-bridge /etc/nginx/sites-enabled/
certbot --nginx -d nostr.bitcoinbutlers.com
```

## API

### Create Invite (admin)
```bash
curl -X POST http://localhost:3848/api/invites \
  -H "Authorization: Bearer YOUR_LISTENER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "Friend Name"}'
```
Returns: `{"success": true, "token": "abc123...", "inviteUrl": "https://nostr.bitcoinbutlers.com?invite=abc123..."}`

### List Invites (admin)
```bash
curl http://localhost:3848/api/invites \
  -H "Authorization: Bearer YOUR_LISTENER_TOKEN"
```

### Register (via invite)
```bash
POST /api/register
{
  "invite": "abc123...",
  "storeName": "My Store",
  "npub": "npub1...",
  "wooUrl": "https://my-store.com",
  "email": "me@my-store.com"
}
```
Returns webhook URL + secret for the merchant to enter in their plugin.

### Health
```bash
curl http://localhost:3848/api/health
```

## Plugin Distribution

The `woo-nostr-market.zip` plugin is served at `/woo-nostr-market.zip` for easy merchant download.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3848) |
| `LISTENER_URL` | Yes | URL of nostr-order-listener (e.g., `http://127.0.0.1:3847`) |
| `LISTENER_TOKEN` | Yes | Admin token for the listener API |
| `INVITES_FILE` | No | Path to invites JSON file (default: `./invites.json`) |

## Related

- [nostr-order-listener](https://github.com/RenAndKiwi/nostr-order-listener) — Relay watcher + order forwarder
- [sovereign-marketplace](https://github.com/RenAndKiwi/sovereign-marketplace) — Full system + WooCommerce plugin
- [woo-nostr-market plugin](https://github.com/RenAndKiwi/sovereign-marketplace/tree/main/wordpress-plugin/woo-nostr-market)

## License

MIT
