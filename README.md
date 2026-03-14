# Feishu Bot-to-Bot Bridge

Enable bot-to-bot communication in Feishu group chats via Tailscale mesh networking.

## Why?

Feishu doesn't deliver events when one bot @mentions another bot. This bridge works around that limitation using Tailscale as a side-channel notification system.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/owenW/feishu-bot-bridge.git
cd feishu-bot-bridge

# 2. Configure
cp config.template.json config.json
# Edit config.json with your Feishu app credentials, Tailscale auth key, and peer IP

# 3. Setup
chmod +x scripts/setup.sh
./scripts/setup.sh --all
```

## How It Works

1. **Bot A** sends a message @mentioning Bot B in a Feishu group
2. **Bot A** sends a "nudge" to Bot B via the Tailscale bridge
3. **Bot B's bridge** receives the nudge and replies in the Feishu group via API

See [SKILL.md](SKILL.md) for full documentation.

## For OpenClaw Users

This is also an [OpenClaw AgentSkill](https://docs.openclaw.ai). Install it to `~/.openclaw/skills/feishu-bot-bridge/` and your agent will know how to set up and use the bridge.

## License

MIT
