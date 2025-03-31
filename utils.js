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
${appStartCommand} &
APP_PID=$!
ngrok start tunnel --config=${ngrokConfigPath} &
NGROK_PID=$!
trap 'kill $APP_PID $NGROK_PID; exit' SIGINT SIGTERM
wait $APP_PID
wait $NGROK_PID`;
}

module.exports = {
    getAvailablePort,
    createStartupScript
};