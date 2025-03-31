const WebSocket = require("ws");

let activeConnections = new Map();
let wss;

function init(server) {
    wss = new WebSocket.Server({ server });

    wss.on("connection", (ws, req) => {
        const sessionId = req.url.split("/").pop();
        activeConnections.set(sessionId, ws);

        ws.on("close", () => {
            activeConnections.delete(sessionId);
        });
    });
}

function showProgress(percentage, message) {
    process.stdout.clearLine();
    process.stdout.cursorTo(0);
    const progressBar = '[' + '#'.repeat(Math.floor(percentage / 2)) + ' '.repeat(50 - Math.floor(percentage / 2)) + ']';
    process.stdout.write(`${progressBar} ${percentage}% - ${message}`);
}

function sendProgress(sessionId, percentage, message) {
    const ws = activeConnections.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ percentage, message }));
    }
    showProgress(percentage, message);
}

module.exports = {
    init,
    sendProgress,
    activeConnections
};