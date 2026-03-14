---
name: feishu-bot-bridge
description: |
  Enable bot-to-bot communication in Feishu group chats via Tailscale mesh network.
  Feishu does not deliver events when one bot @mentions another bot. This skill
  works around that limitation by using Tailscale as a side-channel notification
  system (nudge), allowing bots on different machines to communicate through
  Feishu group chats seamlessly.
---

# Feishu Bot-to-Bot Bridge

## Problem

Feishu's platform does not deliver message events when a bot @mentions another bot in a group chat. Only human @mentions trigger bot events. This makes direct bot-to-bot communication in Feishu groups impossible through normal channels.

## Solution

Use Tailscale mesh networking + HTTP bridge proxies to create a side-channel notification system:

1. **Bot A** sends a message in the Feishu group @mentioning Bot B
2. **Bot A** simultaneously sends a "nudge" to Bot B's machine via the Tailscale bridge
3. **Bot B's bridge** receives the nudge, processes the message, and replies in the Feishu group via API

## Architecture

```
┌──────────────┐    Tailscale Mesh     ┌──────────────┐
│  Machine A   │◄─────────────────────►│  Machine B   │
│              │   (nudge via HTTP)     │              │
│ ┌──────────┐ │                       │ ┌──────────┐ │
│ │ OpenClaw │ │                       │ │ OpenClaw │ │
│ │ Agent A  │ │                       │ │ Agent B  │ │
│ └────┬─────┘ │                       │ └────┬─────┘ │
│      │       │                       │      │       │
│ ┌────▼─────┐ │                       │ ┌────▼─────┐ │
│ │ Bridge   │ │                       │ │ Bridge   │ │
│ │ Proxy    │ │                       │ │ Proxy    │ │
│ │ :18800   │ │                       │ │ :18800   │ │
│ └────┬─────┘ │                       │ └────┬─────┘ │
│      │       │                       │      │       │
│ ┌────▼─────┐ │                       │ ┌────▼─────┐ │
│ │tailscaled│ │                       │ │tailscaled│ │
│ │(userspace│ │                       │ │(userspace│ │
│ └──────────┘ │                       │ └──────────┘ │
└──────┬───────┘                       └──────┬───────┘
       │          Feishu API                  │
       └──────────────┬───────────────────────┘
                      │
               ┌──────▼──────┐
               │ Feishu Group│
               │    Chat     │
               └─────────────┘
```

## Setup

### Prerequisites

- Two machines, each running an OpenClaw agent with a Feishu bot
- Both bots are members of the same Feishu group chat
- Tailscale installed (`brew install tailscale` on macOS)
- A Tailscale account with an auth key (get from https://login.tailscale.com/admin/settings/keys)

### Step 1: Configure

Copy the template config and fill in your values:

```bash
cp config.template.json config.json
```

Edit `config.json`:

```json
{
  "bridge": {
    "port": 18800
  },
  "tailscale": {
    "socket": "/tmp/tailscaled.sock",
    "authKey": "tskey-auth-xxx",
    "peerIp": "100.x.x.x",
    "peerPort": 18800
  },
  "feishu": {
    "appId": "cli_xxx",
    "appSecret": "xxx",
    "groupChatId": "oc_xxx",
    "peerBotUserId": "ou_xxx",
    "peerBotName": "OtherBot"
  }
}
```

### Step 2: Start Tailscale

For environments where Tailscale servers are reachable directly:
```bash
sudo tailscaled &
sudo tailscale up --auth-key=tskey-auth-xxx
```

For environments behind firewalls (e.g., China GFW) where `log.tailscale.com` is blocked, use userspace networking:
```bash
tailscaled --state=/tmp/tailscaled.state \
  --socket=/tmp/tailscaled.sock \
  --tun=userspace-networking \
  --socks5-server=localhost:1055 &

tailscale --socket=/tmp/tailscaled.sock up \
  --auth-key=tskey-auth-xxx
```

Verify connectivity:
```bash
tailscale --socket=/tmp/tailscaled.sock ping <peer_ip>
```

### Step 3: Start Bridge

```bash
node bridge.js
```

Verify:
```bash
curl http://localhost:18800/health
```

### Step 4: Test

Send a test nudge to the peer:
```bash
curl -X POST http://localhost:18800/send-nudge \
  -H "Content-Type: application/json" \
  -d '{"type":"feishu_mention","from":"MyBot","message":"Hello from the other side!"}'
```

### Step 5: Add Agent Rule

Add to your agent's `SOUL.md`:

```
## Bot-to-Bot Communication
When sending a Feishu group message that @mentions another bot:
1. Send the Feishu message normally
2. Immediately call: curl -X POST http://localhost:18800/send-nudge \
   -H "Content-Type: application/json" \
   -d '{"type":"feishu_mention","from":"<my_bot_name>","message":"<message_content>","chat_id":"<group_chat_id>"}'
```

## Persistence (macOS launchd)

### Bridge Proxy

```bash
# Install the launchd plist
cp scripts/com.openclaw.bridge.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openclaw.bridge.plist
```

### Tailscale (userspace mode)

```bash
cp scripts/com.openclaw.tailscaled.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openclaw.tailscaled.plist
```

## API Reference

### GET /health
Returns bridge status.

### POST /nudge
Receive a notification from a peer bot.

**Body:**
```json
{
  "type": "feishu_mention",
  "from": "BotName",
  "message": "The message content",
  "chat_id": "oc_xxx"
}
```

**Response:** Processes the message and replies in the Feishu group.

### POST /send-nudge
Send a notification to the peer bot via Tailscale.

**Body:** Same as `/nudge` — forwarded to peer's `/nudge` endpoint.

## Stability Design

- **No session dependency**: Bridge runs as an independent process, not tied to any agent session
- **Auto-restart**: launchd plists with `KeepAlive: true` ensure services restart on crash
- **Token refresh**: Feishu tenant tokens auto-refresh before expiry
- **Graceful degradation**: If Tailscale is down, nudges fail but Feishu messaging still works
- **Health monitoring**: `/health` endpoint for external monitoring
- **Userspace networking**: Works without root/sudo for Tailscale in restricted environments

## Limitations

- Latency: ~300-500ms per nudge (Tailscale DERP relay + Feishu API)
- Requires Tailscale network connectivity between machines
- Currently supports one peer per bridge instance (extend config for multi-peer)
- In China/GFW environments, Tailscale requires reachable DERP servers
