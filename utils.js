const fs = require("fs");
const path = require("path");
const Docker = require("dockerode");
const docker = new Docker();

async function getAvailablePort() {
    const basePort = 30000;
    const maxPort = 40000;
    const usedPorts = new Set();

    const containers = await docker.listContainers();
    for (const container of containers) {
        if (container.Ports) {
            container.Ports.forEach(port => {
                if (port.PublicPort) usedPorts.add(port.PublicPort);
            });
        }
    }

    let port;
    do {
        port = Math.floor(Math.random() * (maxPort - basePort) + basePort);
    } while (usedPorts.has(port));

    return port;
}

function createStartupScript(ngrokConfigPath, appStartCommand) {
    return `#!/bin/sh
# Start ngrok in the background
ngrok start --config ${ngrokConfigPath} --all &
NGROK_PID=$!

# If the exposed port and internal port are different, set up port forwarding
if [ "$INTERNAL_PORT" != "$PORT" ]; then
  echo "Setting up port forwarding from $PORT to $INTERNAL_PORT"
  socat TCP-LISTEN:$PORT,fork TCP:localhost:$INTERNAL_PORT &
  SOCAT_PID=$!
fi

# Start the application
echo "Starting application on port $INTERNAL_PORT"
${appStartCommand} &
APP_PID=$!

# Handle graceful shutdown
trap 'kill $APP_PID $NGROK_PID $SOCAT_PID 2>/dev/null; exit' SIGINT SIGTERM
wait $APP_PID
`;
}

module.exports = {
    getAvailablePort,
    createStartupScript
};