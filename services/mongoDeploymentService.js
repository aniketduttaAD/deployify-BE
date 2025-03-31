const fs = require("fs");
const crypto = require("crypto");
const { PROJECTS_DIR, NGROK_AUTHTOKEN } = require("../config");
const { sendProgress } = require("./progressService");
const { ensureImageExists, cleanupContainer, docker } = require("./dockerService");
const { createNgrokReservedAddress, createNgrokReservedDomain, generateNgrokConfig } = require("./ngrokService");
const { getAvailablePort, createStartupScript } = require("../utils");

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

    const containerName = `deployify-${projectName}`;
    const mongoExpressName = `mongo-express-${projectName}`;

    try {
        const containers = await docker.listContainers({ all: true });
        if (containers.some((c) => c.Names.includes(`/${containerName}`))) {
            return res.status(400).json({
                error: `Container '${containerName}' already exists. Please choose a different project name.`,
            });
        }

        sendProgress(sessionId, 5, "Checking MongoDB image...");
        await ensureImageExists("mongo:6.0");

        sendProgress(sessionId, 15, "Generating credentials...");
        const mongoPassword = crypto.randomBytes(16).toString("hex");
        const mongoPort = await getAvailablePort();

        sendProgress(sessionId, 25, "Creating Ngrok reserved address for MongoDB...");
        let mongoNgrokAddress;
        try {
            const reservedAddress = await createNgrokReservedAddress(`MongoDB-${projectName}`);
            mongoNgrokAddress = reservedAddress.addr;
        } catch (err) {
            return res.status(500).json({
                error: "Failed to create Ngrok reserved address: " + err.message
            });
        }

        sendProgress(sessionId, 30, "Creating MongoDB container with ngrok tunnel...");
        const mongoSetupDir = `${PROJECTS_DIR}/mongo-${projectName}`;
        fs.mkdirSync(mongoSetupDir, { recursive: true });

        const ngrokConfigContent = generateNgrokConfig(NGROK_AUTHTOKEN, 'tcp', {
            remoteAddr: mongoNgrokAddress,
            port: 27017
        });
        fs.writeFileSync(`${mongoSetupDir}/ngrok.yml`, ngrokConfigContent);

        const mongoDockerfile = `
FROM mongo:6.0
RUN apt-get update && apt-get install -y curl unzip && \\
    curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip
RUN mkdir -p /root/.config/ngrok
COPY ngrok.yml /root/.config/ngrok/ngrok.yml
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 27017
CMD ["/start.sh"]`;
        fs.writeFileSync(`${mongoSetupDir}/Dockerfile`, mongoDockerfile);

        const mongoStartScript = createStartupScript('/root/.config/ngrok/ngrok.yml', 'mongod --auth');
        fs.writeFileSync(`${mongoSetupDir}/start.sh`, mongoStartScript);

        sendProgress(sessionId, 35, "Building MongoDB container image...");
        const mongoBuildStream = await docker.buildImage(
            { context: mongoSetupDir, src: ["Dockerfile", "ngrok.yml", "start.sh"] },
            { t: containerName }
        );

        await new Promise((resolve, reject) => {
            docker.modem.followProgress(mongoBuildStream, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        sendProgress(sessionId, 45, "Starting MongoDB container...");
        const mongoContainer = await docker.createContainer({
            Image: containerName,
            name: containerName,
            Env: [
                `MONGO_INITDB_ROOT_USERNAME=admin`,
                `MONGO_INITDB_ROOT_PASSWORD=${mongoPassword}`,
            ],
            ExposedPorts: { "27017/tcp": {} },
            HostConfig: {
                PortBindings: { "27017/tcp": [{ HostPort: mongoPort.toString() }] },
            },
        });
        await mongoContainer.start();

        sendProgress(sessionId, 50, "Setting up Mongo Express...");
        await ensureImageExists("mongo-express:latest");

        const mongoExpressPort = await getAvailablePort();
        const ngrokHost = mongoNgrokAddress.split(":")[0];
        const ngrokPort = mongoNgrokAddress.split(":")[1];
        const mongoUri = `mongodb://admin:${mongoPassword}@${ngrokHost}:${ngrokPort}/?authSource=admin`;

        sendProgress(sessionId, 60, "Creating Ngrok domain for Mongo Express...");
        let mongoExpressDomain;
        try {
            const subdomain = `deployify-${projectName}.ngrok.app`;
            const reservedDomain = await createNgrokReservedDomain(subdomain);
            mongoExpressDomain = reservedDomain.domain;
        } catch (err) {
            await cleanupContainer(containerName, sessionId, null);
            return res.status(500).json({
                error: "Failed to create Ngrok domain for Mongo Express: " + err.message
            });
        }

        const expressSetupDir = `${PROJECTS_DIR}/mongo-express-${projectName}`;
        fs.mkdirSync(expressSetupDir, { recursive: true });

        const expressNgrokConfig = generateNgrokConfig(NGROK_AUTHTOKEN, 'http', {
            domain: mongoExpressDomain,
            port: 8081
        });
        fs.writeFileSync(`${expressSetupDir}/ngrok.yml`, expressNgrokConfig);

        const expressDockerfile = `
FROM mongo-express:latest
USER root
RUN apt-get update && apt-get install -y curl unzip && \\
    curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip
RUN mkdir -p /root/.config/ngrok
COPY ngrok.yml /root/.config/ngrok/ngrok.yml
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE 8081
CMD ["/start.sh"]`;
        fs.writeFileSync(`${expressSetupDir}/Dockerfile`, expressDockerfile);

        const expressStartScript = createStartupScript('/root/.config/ngrok/ngrok.yml', 'node app');
        fs.writeFileSync(`${expressSetupDir}/start.sh`, expressStartScript);

        sendProgress(sessionId, 70, "Building Mongo Express container image...");
        const expressBuildStream = await docker.buildImage(
            { context: expressSetupDir, src: ["Dockerfile", "ngrok.yml", "start.sh"] },
            { t: mongoExpressName }
        );

        await new Promise((resolve, reject) => {
            docker.modem.followProgress(expressBuildStream, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        sendProgress(sessionId, 85, "Starting Mongo Express container...");
        const mongoExpressContainer = await docker.createContainer({
            Image: mongoExpressName,
            name: mongoExpressName,
            Env: [
                `ME_CONFIG_MONGODB_URL=${mongoUri}`,
                `ME_CONFIG_MONGODB_ADMINUSERNAME=admin`,
                `ME_CONFIG_MONGODB_ADMINPASSWORD=${mongoPassword}`,
                `ME_CONFIG_MONGODB_PORT=${ngrokPort}`,
                `ME_CONFIG_BASICAUTH_USERNAME=admin`,
                `ME_CONFIG_BASICAUTH_PASSWORD=${mongoPassword}`,
            ],
            ExposedPorts: { "8081/tcp": {} },
            HostConfig: {
                PortBindings: { "8081/tcp": [{ HostPort: mongoExpressPort.toString() }] },
            },
        });

        await mongoExpressContainer.start();
        sendProgress(sessionId, 100, "MongoDB deployment complete!");

        return res.status(200).json({
            message: "MongoDB and Mongo Express are successfully set up.",
            mongodbUrl: mongoNgrokAddress,
            mongoExpressUrl: `https://${mongoExpressDomain}`,
            username: "admin",
            password: mongoPassword,
        });
    } catch (error) {
        await cleanupContainer(mongoExpressName, sessionId, null);
        return res.status(500).json({
            error: await cleanupContainer(
                containerName,
                sessionId,
                "Failed to deploy MongoDB: " + error.message
            ),
        });
    }
}

module.exports = { deployMongoDB };