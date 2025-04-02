const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { PROJECTS_DIR, NGROK_AUTHTOKEN } = require("../config");
const { sendProgress } = require("./progressService");
const { ensureImageExists, cleanupContainer, docker } = require("./dockerService");
const { createNgrokReservedAddress } = require("./ngrokService");
const { getAvailablePort } = require("../utils");

async function deployMongoDB(req, res) {
    const { projectName } = req.body;
    const sessionId = req.query.sessionId;

    if (!projectName) {
        return res.status(400).json({ error: "Invalid request data." });
    }

    if (!NGROK_AUTHTOKEN) {
        return res.status(500).json({
            error: "Missing ngrok auth token configuration."
        });
    }

    const mongoContainerName = `deployify-${projectName}`;
    const ngrokContainerName = `ngrok-${projectName}`;

    try {
        const containers = await docker.listContainers({ all: true });
        if (containers.some(c => c.Names.includes(`/${mongoContainerName}`))) {
            return res.status(400).json({
                error: `Container '${mongoContainerName}' already exists. Please choose a different project name.`,
            });
        }
        sendProgress(sessionId, 10, "Creating Ngrok reserved TCP address...");
        let tcpAddress;
        try {
            tcpAddress = await createNgrokReservedAddress(`MongoDB-${projectName}`);
        } catch (err) {
            return res.status(500).json({
                error: "Failed to create Ngrok reserved address: " + err.message
            });
        }
        // Extract host and port from TCP address
        const tcpHostPort = tcpAddress.replace('tcp://', '');
        const remoteTcpHost = tcpHostPort.split(':')[0];
        const remoteTcpPort = tcpHostPort.split(':')[1];

        // Step 2: Generate a port
        sendProgress(sessionId, 20, "Generating container port...");
        const containerPort = await getAvailablePort();

        // Generate admin credentials
        sendProgress(sessionId, 30, "Generating secure credentials...");
        const adminUser = "admin";
        const adminPassword = crypto.randomBytes(16).toString("hex");

        // Step 3: Create MongoDB container
        sendProgress(sessionId, 40, "Setting up MongoDB container...");

        await ensureImageExists("mongo:6.0");

        // Create MongoDB container
        const mongoContainer = await docker.createContainer({
            Image: "mongo:6.0",
            name: mongoContainerName,
            Cmd: ["--port", `${containerPort}`, "--bind_ip", "0.0.0.0", "--auth"],
            ExposedPorts: { [`${containerPort}/tcp`]: {} },
            HostConfig: {
                PortBindings: { [`${containerPort}/tcp`]: [{ HostPort: containerPort.toString() }] },
                NetworkMode: "bridge"
            },
            Env: [
                `MONGO_INITDB_ROOT_USERNAME=${adminUser}`,
                `MONGO_INITDB_ROOT_PASSWORD=${adminPassword}`
            ]
        });

        await mongoContainer.start();

        // Wait for MongoDB to start
        sendProgress(sessionId, 50, "Waiting for MongoDB to initialize...");
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Step 4: Create Ngrok container connected to MongoDB
        sendProgress(sessionId, 60, "Setting up Ngrok TCP tunnel...");

        await ensureImageExists("ngrok/ngrok");

        const ngrokContainer = await docker.createContainer({
            Image: "ngrok/ngrok",
            name: ngrokContainerName,
            Cmd: [
                "tcp",
                `host.docker.internal:${containerPort}`,
                "--region=us",
                `--remote-addr=${tcpHostPort}`
            ],
            ExposedPorts: { "4040/tcp": {} },
            HostConfig: {
                PortBindings: { "4040/tcp": [{ HostPort: "4040" }] },
                NetworkMode: "bridge",
                ExtraHosts: ["host.docker.internal:host-gateway"]
            },
            Env: [
                `NGROK_AUTHTOKEN=${NGROK_AUTHTOKEN}`
            ]
        });

        await ngrokContainer.start();

        // Wait for ngrok to establish connection
        sendProgress(sessionId, 80, "Establishing ngrok tunnel...");
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Send success response
        sendProgress(sessionId, 100, "MongoDB deployment complete!");

        return res.status(200).json({
            message: "MongoDB successfully deployed",
            mongodbUrl: tcpAddress,
            username: adminUser,
            password: adminPassword,
            connectionString: `mongodb://${adminUser}:${adminPassword}@${tcpHostPort}/?authSource=admin`,
            port: containerPort.toString()
        });

    } catch (error) {
        // Clean up containers if something went wrong
        await cleanupContainer(ngrokContainerName, null, null);
        await cleanupContainer(mongoContainerName, sessionId, null);

        return res.status(500).json({
            error: `Failed to deploy MongoDB: ${error.message}`
        });
    }
}

module.exports = { deployMongoDB };