#!/bin/bash
# Feishu Bot-to-Bot Bridge Setup Script
# Usage: ./setup.sh [--install-tailscale] [--install-bridge] [--all]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Feishu Bot-to-Bot Bridge Setup ==="
echo "Project dir: $PROJECT_DIR"

# Check prerequisites
check_prereqs() {
    echo ""
    echo "Checking prerequisites..."
    
    if ! command -v node &>/dev/null; then
        echo "❌ Node.js not found. Install with: brew install node"
        exit 1
    fi
    echo "✅ Node.js $(node --version)"
    
    if ! command -v tailscale &>/dev/null; then
        echo "❌ Tailscale not found. Install with: brew install tailscale"
        exit 1
    fi
    echo "✅ Tailscale installed"
    
    if [ ! -f "$PROJECT_DIR/config.json" ]; then
        echo "❌ config.json not found. Copy from template:"
        echo "   cp $PROJECT_DIR/config.template.json $PROJECT_DIR/config.json"
        echo "   Then edit config.json with your values."
        exit 1
    fi
    echo "✅ config.json found"
}

install_tailscale() {
    echo ""
    echo "=== Setting up Tailscale ==="
    
    AUTH_KEY=$(python3 -c "import json; c=json.load(open('$PROJECT_DIR/config.json')); print(c['tailscale']['authKey'])" 2>/dev/null || echo "")
    TS_SOCKET=$(python3 -c "import json; c=json.load(open('$PROJECT_DIR/config.json')); print(c['tailscale'].get('socket', '/tmp/tailscaled.sock'))" 2>/dev/null)
    
    if [ -z "$AUTH_KEY" ] || [ "$AUTH_KEY" = "tskey-auth-xxxx" ]; then
        echo "❌ Set tailscale.authKey in config.json first"
        exit 1
    fi
    
    # Start tailscaled in userspace mode
    echo "Starting tailscaled (userspace networking)..."
    pkill -f "tailscaled.*userspace" 2>/dev/null || true
    sleep 1
    
    tailscaled --state=/tmp/tailscaled.state \
        --socket="$TS_SOCKET" \
        --tun=userspace-networking \
        --socks5-server=localhost:1055 &
    sleep 3
    
    # Authenticate
    echo "Authenticating with Tailscale..."
    tailscale --socket="$TS_SOCKET" up --auth-key="$AUTH_KEY" --timeout=60s
    
    echo ""
    echo "Tailscale status:"
    tailscale --socket="$TS_SOCKET" status
    echo ""
    echo "✅ Tailscale connected"
}

install_bridge() {
    echo ""
    echo "=== Setting up Bridge ==="
    
    # Kill existing
    pkill -f "node.*bridge.js" 2>/dev/null || true
    sleep 1
    
    # Start bridge
    cd "$PROJECT_DIR"
    node bridge.js &
    sleep 2
    
    # Health check
    HEALTH=$(curl -s http://localhost:18800/health 2>/dev/null || echo "FAILED")
    if echo "$HEALTH" | grep -q '"ok"'; then
        echo "✅ Bridge running and healthy"
    else
        echo "❌ Bridge health check failed: $HEALTH"
        exit 1
    fi
}

install_launchd() {
    echo ""
    echo "=== Installing launchd services ==="
    
    # Update plist paths to actual project directory
    sed "s|/Users/mt/tailscale-bridge|$PROJECT_DIR|g" \
        "$SCRIPT_DIR/com.openclaw.bridge.plist" > ~/Library/LaunchAgents/com.openclaw.bridge.plist
    
    cp "$SCRIPT_DIR/com.openclaw.tailscaled.plist" ~/Library/LaunchAgents/
    
    launchctl load ~/Library/LaunchAgents/com.openclaw.tailscaled.plist 2>/dev/null || true
    launchctl load ~/Library/LaunchAgents/com.openclaw.bridge.plist 2>/dev/null || true
    
    echo "✅ launchd services installed (auto-start on boot)"
}

# Parse args
case "${1:-}" in
    --install-tailscale)
        check_prereqs
        install_tailscale
        ;;
    --install-bridge)
        check_prereqs
        install_bridge
        ;;
    --install-launchd)
        check_prereqs
        install_launchd
        ;;
    --all)
        check_prereqs
        install_tailscale
        install_bridge
        install_launchd
        ;;
    *)
        check_prereqs
        echo ""
        echo "Usage: $0 [--install-tailscale] [--install-bridge] [--install-launchd] [--all]"
        echo ""
        echo "  --install-tailscale  Start tailscaled and authenticate"
        echo "  --install-bridge     Start the bridge proxy"
        echo "  --install-launchd    Install launchd plists for persistence"
        echo "  --all                Do everything"
        ;;
esac

echo ""
echo "Done!"
