require('dotenv').config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const Docker = require("dockerode");
const crypto = require("crypto");
const WebSocket = require("ws");
const axios = require('axios');

const upload = multer({ dest: "uploads/" });
const PROJECTS_DIR = path.resolve(__dirname, "uploads");
const docker = new Docker();
const PORT = 5002;

const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN;
const NGROK_APITOKEN = process.env.NGROK_APITOKEN;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const activeConnections = new Map();

app.use(
    cors({
        origin: "*",
        methods: ["GET", "POST"],
        allowedHeaders: ["Content-Type"],
    })
);
app.use(express.json());

app.get("/health", (req, res) => {
    res.status(200).json({ message: "Server is running" });
});

wss.on("connection", (ws, req) => {
    const sessionId = req.url.split("/").pop();
    activeConnections.set(sessionId, ws);

    ws.on("close", () => {
        activeConnections.delete(sessionId);
    });
});

// For terminal progress display
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

    // Display progress in terminal
    showProgress(percentage, message);
}

async function getAvailablePort() {
    const basePort = 30000;
    const maxPort = 40000;
    const usedPorts = new Set();

    const containers = await docker.listContainers();

    for (const container of containers) {
        if (container.Ports) {
            container.Ports.forEach((port) => {
                if (port.PublicPort) {
                    usedPorts.add(port.PublicPort);
                }
            });
        }
    }

    let port;
    do {
        port = Math.floor(Math.random() * (maxPort - basePort) + basePort);
    } while (usedPorts.has(port));

    return port;
}

async function imageExists(imageName) {
    try {
        const images = await docker.listImages();
        return images.some(
            (img) => img.RepoTags && img.RepoTags.includes(`${imageName}:latest`)
        );
    } catch (error) {
        console.error(`Error checking if image ${imageName} exists:`, error);
        return false;
    }
}

async function ensureImageExists(imageName) {
    try {
        if (await imageExists(imageName)) {
            console.log(`Image ${imageName} already exists, skipping pull.`);
            return true;
        }

        console.log(`Pulling ${imageName} image...`);
        const pullStream = await docker.pull(imageName);

        return new Promise((resolve, reject) => {
            docker.modem.followProgress(pullStream, (err, res) => {
                if (err) {
                    console.error(`Error pulling ${imageName} image:`, err);
                    reject(new Error(`Failed to pull ${imageName} image.`));
                } else {
                    console.log(`${imageName} image pulled successfully.`);
                    resolve(true);
                }
            });
        });
    } catch (err) {
        console.error(`Error ensuring ${imageName} image exists:`, err);
        throw new Error(`Failed to ensure ${imageName} image.`);
    }
}

async function cleanupContainer(containerName, sessionId, errorMessage) {
    try {
        const containers = await docker.listContainers({ all: true });
        const container = containers.find((c) =>
            c.Names.includes(`/${containerName}`)
        );

        if (container) {
            const containerObj = docker.getContainer(container.Id);

            try {
                await containerObj.stop({ t: 5 });
            } catch (stopError) {
                console.log(
                    `Container ${containerName} already stopped or stopping failed`,
                    stopError
                );
            }

            try {
                await containerObj.remove();
                console.log(`Container ${containerName} removed successfully`);
            } catch (removeError) {
                console.error(
                    `Error removing container ${containerName}:`,
                    removeError
                );
            }
        }

        if (sessionId && errorMessage) {
            sendProgress(sessionId, 0, `Error: ${errorMessage}`);
        }

        return errorMessage;
    } catch (error) {
        console.error(`Error during cleanup for ${containerName}:`, error);
        return errorMessage || "An unexpected error occurred";
    }
}

async function createNgrokReservedAddress(description) {
    try {
        const response = await axios.post(
            'https://api.ngrok.com/reserved_addrs',
            { description: description, region: 'us' },
            {
                headers: {
                    'Authorization': `Bearer ${NGROK_APITOKEN}`,
                    'Content-Type': 'application/json',
                    'Ngrok-Version': '2'
                }
            }
        );
        return response.data;
    } catch (error) {
        console.error('Error creating Ngrok reserved address:', error.response ? error.response.data : error.message);
        throw error;
    }
}

async function createNgrokReservedDomain(domain) {
    try {
        const response = await axios.post(
            'https://api.ngrok.com/reserved_domains',
            { domain: domain, region: 'us' },
            {
                headers: {
                    'Authorization': `Bearer ${NGROK_APITOKEN}`,
                    'Content-Type': 'application/json',
                    'Ngrok-Version': '2'
                }
            }
        );
        return response.data;
    } catch (error) {
        console.error('Error creating Ngrok reserved domain:', error.response ? error.response.data : error.message);
        throw error;
    }
}

// Generate the ngrok config content
function generateNgrokConfig(authToken, tunnelType, options) {
    let config = `version: 3
agent:
  authtoken: ${authToken}
endpoints:
  - name: tunnel
`;

    if (tunnelType === 'http') {
        config += `    url: ${options.domain}
    upstream:
      url: http://localhost:${options.port}`;
    } else if (tunnelType === 'tcp') {
        config += `    url: tcp://${options.remoteAddr}
    upstream:
      url: tcp://localhost:${options.port}
      protocol: tcp`;
    }

    return config;
}

// Create a startup script that runs both the app and ngrok
function createStartupScript(ngrokConfigPath, appStartCommand) {
    return `#!/bin/sh
# Start the application in the background
${appStartCommand} &
APP_PID=$!

# Start ngrok
ngrok start tunnel --config=${ngrokConfigPath} &
NGROK_PID=$!

# Handle signals
trap 'kill $APP_PID $NGROK_PID; exit' SIGINT SIGTERM

# Wait for processes to complete
wait $APP_PID
wait $NGROK_PID
`;
}

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
            console.error("Error creating Ngrok reserved address for MongoDB:", err);
            return res.status(500).json({
                error: "Failed to create Ngrok reserved address: " + err.message
            });
        }

        // Generate MongoDB container with ngrok built-in
        sendProgress(sessionId, 30, "Creating MongoDB container with ngrok tunnel...");

        // Create a temporary directory for MongoDB setup
        const mongoSetupDir = `${PROJECTS_DIR}/mongo-${projectName}`;
        fs.mkdirSync(mongoSetupDir, { recursive: true });

        // Create ngrok config file
        const ngrokConfigContent = generateNgrokConfig(NGROK_AUTHTOKEN, 'tcp', {
            remoteAddr: mongoNgrokAddress,
            port: 27017
        });
        fs.writeFileSync(`${mongoSetupDir}/ngrok.yml`, ngrokConfigContent);

        // Create MongoDB Dockerfile with ngrok
        const mongoDockerfile = `
FROM mongo:6.0

# Install ngrok
RUN apt-get update && apt-get install -y curl unzip && \\
    curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip

# Copy ngrok config
COPY ngrok.yml /root/.config/ngrok/ngrok.yml

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 27017

CMD ["/start.sh"]
`;
        fs.writeFileSync(`${mongoSetupDir}/Dockerfile`, mongoDockerfile);

        // Create startup script
        const mongoStartScript = createStartupScript('/root/.config/ngrok/ngrok.yml', 'mongod --auth');
        fs.writeFileSync(`${mongoSetupDir}/start.sh`, mongoStartScript);

        // Build the MongoDB container
        sendProgress(sessionId, 35, "Building MongoDB container image...");
        const mongoBuildStream = await docker.buildImage(
            {
                context: mongoSetupDir,
                src: ["Dockerfile", "ngrok.yml", "start.sh"],
            },
            { t: containerName }
        );

        await new Promise((resolve, reject) => {
            docker.modem.followProgress(mongoBuildStream, (err, res) => {
                if (err) reject(err);
                else resolve(res);
            });
        });

        // Start MongoDB container
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

        // Now set up Mongo Express with its own ngrok tunnel
        sendProgress(sessionId, 50, "Setting up Mongo Express...");
        await ensureImageExists("mongo-express:latest");

        const mongoExpressPort = await getAvailablePort();
        const ngrokHost = mongoNgrokAddress.split(":")[0];
        const ngrokPort = mongoNgrokAddress.split(":")[1];
        const mongoUri = `mongodb://admin:${mongoPassword}@${ngrokHost}:${ngrokPort}/?authSource=admin`;

        // Create reserved domain for Mongo Express
        sendProgress(sessionId, 60, "Creating Ngrok domain for Mongo Express...");
        let mongoExpressDomain;
        try {
            const subdomain = `deployify-${projectName}.ngrok.app`;
            const reservedDomain = await createNgrokReservedDomain(subdomain);
            mongoExpressDomain = reservedDomain.domain;
        } catch (err) {
            console.error("Error creating Ngrok domain for Mongo Express:", err);
            await cleanupContainer(containerName, sessionId, null);
            return res.status(500).json({
                error: "Failed to create Ngrok domain for Mongo Express: " + err.message
            });
        }

        // Create a temporary directory for Mongo Express setup
        const expressSetupDir = `${PROJECTS_DIR}/mongo-express-${projectName}`;
        fs.mkdirSync(expressSetupDir, { recursive: true });

        // Create ngrok config file for Mongo Express
        const expressNgrokConfig = generateNgrokConfig(NGROK_AUTHTOKEN, 'http', {
            domain: mongoExpressDomain,
            port: 8081
        });
        fs.writeFileSync(`${expressSetupDir}/ngrok.yml`, expressNgrokConfig);

        // Create Mongo Express Dockerfile with ngrok
        const expressDockerfile = `
FROM mongo-express:latest

# Install ngrok
USER root
RUN apt-get update && apt-get install -y curl unzip && \\
    curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip

# Create the ngrok config directory
RUN mkdir -p /root/.config/ngrok

# Copy ngrok config
COPY ngrok.yml /root/.config/ngrok/ngrok.yml

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 8081

CMD ["/start.sh"]
`;
        fs.writeFileSync(`${expressSetupDir}/Dockerfile`, expressDockerfile);

        // Create startup script for Mongo Express
        const expressStartScript = createStartupScript('/root/.config/ngrok/ngrok.yml', 'node app');
        fs.writeFileSync(`${expressSetupDir}/start.sh`, expressStartScript);

        // Build the Mongo Express container
        sendProgress(sessionId, 70, "Building Mongo Express container image...");
        const expressBuildStream = await docker.buildImage(
            {
                context: expressSetupDir,
                src: ["Dockerfile", "ngrok.yml", "start.sh"],
            },
            { t: mongoExpressName }
        );

        await new Promise((resolve, reject) => {
            docker.modem.followProgress(expressBuildStream, (err, res) => {
                if (err) reject(err);
                else resolve(res);
            });
        });

        // Start Mongo Express container
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
                PortBindings: {
                    "8081/tcp": [{ HostPort: mongoExpressPort.toString() }],
                },
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
        console.error("Error setting up MongoDB:", error);
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

async function deployApplication(req, res) {
    const { projectName, files, language, runCommand } = req.body;
    const sessionId = req.query.sessionId;

    if (!NGROK_AUTHTOKEN) {
        return res.status(500).json({
            error: "Missing ngrok auth token configuration."
        });
    }

    try {
        if (!projectName || !files || !Array.isArray(files) || !language) {
            return res.status(400).json({ error: "Invalid request data." });
        }

        const projectPath = `${PROJECTS_DIR}/${projectName}`;
        const containerName = `deployify-${projectName}`;

        const containers = await docker.listContainers({ all: true });
        if (containers.some((c) => c.Names.includes(`/${containerName}`))) {
            return res.status(400).json({
                error: `Container '${containerName}' already exists. Please choose a different project name.`,
            });
        }

        sendProgress(sessionId, 5, "Creating project directory...");
        fs.mkdirSync(projectPath, { recursive: true });

        let completed = 0;
        const totalFiles = files.length;

        for (const file of files) {
            const { path: filePath, content } = file;
            const fullPath = path.join(projectPath, filePath);
            const dir = path.dirname(fullPath);

            fs.mkdirSync(dir, { recursive: true });

            if (content) {
                let fileContent = Buffer.from(content, "base64").toString();
                if (
                    language === "nodejs" &&
                    (filePath === "server.js" || filePath.endsWith(".js"))
                ) {
                    const newPort = "process.env.PORT || 8080";
                    fileContent = fileContent.replace(
                        /const\s+PORT\s*=\s*\d+;/,
                        `const PORT = ${newPort};`
                    );
                }
                fs.writeFileSync(fullPath, fileContent);
            }

            completed++;
            const percentage = Math.floor((completed / totalFiles) * 20) + 5;
            sendProgress(
                sessionId,
                percentage,
                `Processing file ${completed}/${totalFiles}`
            );
        }

        sendProgress(sessionId, 30, "Preparing Docker environment...");

        let baseImage, installCommand, defaultRunCommand, exposedPort;

        switch (language) {
            case "nodejs":
                baseImage = "node:23-alpine3.20";
                installCommand = "npm install";
                defaultRunCommand = runCommand || "node server.js";
                break;
            case "python":
                baseImage = "python:3.13.1-alpine3.21";
                installCommand = "pip install -r requirements.txt";
                defaultRunCommand =
                    runCommand || "python manage.py runserver 0.0.0.0:8000";
                break;
            case "php":
                baseImage = "php:8.2-cli";
                installCommand = "composer install";
                const runCommandParts = runCommand ? runCommand.split(" ") : [];
                const scriptFileName = runCommandParts[1]?.trim() || "index.php";
                break;
            case "golang":
                baseImage = "golang:1.23.5-alpine3.21";
                const fileName =
                    runCommand?.substring(runCommand.lastIndexOf("/") + 1).trim() ||
                    "main";
                installCommand = `go mod tidy && go build -o /tmp/${fileName} .`;
                break;
            case "nextjs":
                baseImage = "node:23-alpine3.20";
                break;
            case "reactjs":
                baseImage = "node:23-alpine3.20";
                break;
            case "vuejs":
                baseImage = "node:23-alpine3.20";
                break;
            case "angularjs":
                baseImage = "node:23-alpine3.20";
                break;
            case "html":
                baseImage = "node:23-alpine3.20";
                break;
            default:
                return res.status(400).json({ error: "Unsupported language." });
        }

        sendProgress(sessionId, 35, `Checking for ${baseImage} image...`);
        await ensureImageExists(baseImage);

        exposedPort = await getAvailablePort();

        // Create Ngrok domain for this application
        sendProgress(sessionId, 40, "Creating Ngrok domain...");
        let appDomain;
        try {
            const subdomain = `deployify-${projectName}.ngrok.app`;
            const reservedDomain = await createNgrokReservedDomain(subdomain);
            appDomain = reservedDomain.domain;
        } catch (err) {
            console.error("Error creating Ngrok domain:", err);
            return res.status(500).json({
                error: "Failed to create Ngrok domain: " + err.message
            });
        }

        // Create ngrok config file
        const ngrokConfigContent = generateNgrokConfig(NGROK_AUTHTOKEN, 'http', {
            domain: appDomain,
            port: exposedPort
        });
        fs.writeFileSync(`${projectPath}/ngrok.yml`, ngrokConfigContent);

        sendProgress(sessionId, 45, "Creating Dockerfile...");
        let dockerfile, appStartCommand;

        switch (language) {
            case "nodejs":
                appStartCommand = defaultRunCommand;
                dockerfile = `
FROM ${baseImage}
WORKDIR /app
COPY . /app
RUN ${installCommand}
ENV PORT=${exposedPort}

# Install ngrok
RUN apk add --no-cache curl unzip
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip

# Create the ngrok config directory
RUN mkdir -p /root/.config/ngrok

# Copy ngrok config
COPY ngrok.yml /root/.config/ngrok/ngrok.yml

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE ${exposedPort}
CMD ["/start.sh"]
`;
                break;
            case "python":
                appStartCommand = defaultRunCommand;
                dockerfile = `
FROM ${baseImage}
WORKDIR /app
COPY . /app
RUN ${installCommand}
ENV PORT=${exposedPort}

# Install ngrok
RUN apk add --no-cache curl unzip
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip

# Create the ngrok config directory
RUN mkdir -p /root/.config/ngrok

# Copy ngrok config
COPY ngrok.yml /root/.config/ngrok/ngrok.yml

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE ${exposedPort}
CMD ["/start.sh"]
`;
                break;
            case "php":
                const phpScriptFileName =
                    (runCommand ? runCommand.split(" ")[1] : null) || "index.php";
                appStartCommand = `php -S 0.0.0.0:${exposedPort} -t /var/www/html ${phpScriptFileName}`;
                dockerfile = `
FROM ${baseImage}
WORKDIR /var/www/html
COPY . /var/www/html
RUN apt-get update && apt-get install -y \\
    libpng-dev \\
    libjpeg-dev \\
    libfreetype6-dev \\
    curl \\
    unzip && \\
    docker-php-ext-configure gd --with-freetype --with-jpeg && \\
    docker-php-ext-install gd && \\
    curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer && \\
    ${installCommand}

# Install ngrok
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip

# Create the ngrok config directory
RUN mkdir -p /root/.config/ngrok

# Copy ngrok config
COPY ngrok.yml /root/.config/ngrok/ngrok.yml

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE ${exposedPort}
CMD ["/start.sh"]
`;
                break;
            case "golang":
                const goFileName =
                    (runCommand
                        ? runCommand.substring(runCommand.lastIndexOf("/") + 1).trim()
                        : null) || "main";
                appStartCommand = `/tmp/${goFileName}`;
                dockerfile = `
FROM ${baseImage}
WORKDIR /app
COPY . /app
RUN ${installCommand}

# Install ngrok
RUN apk add --no-cache curl unzip
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip

# Create the ngrok config directory
RUN mkdir -p /root/.config/ngrok

# Copy ngrok config
COPY ngrok.yml /root/.config/ngrok/ngrok.yml

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE ${exposedPort}
CMD ["/start.sh"]
`;
                break;
            case "nextjs":
                appStartCommand = "yarn start";
                dockerfile = `
FROM ${baseImage}
WORKDIR /app
COPY package.json ./
RUN if ! command -v yarn; then npm install -g yarn; fi
RUN yarn install
RUN node -e "let p=require('./package.json'); if(!p.scripts.build) { p.scripts.build='next build'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)) }"
COPY . .
RUN yarn run build
ENV PORT=${exposedPort}

# Install ngrok
RUN apk add --no-cache curl unzip
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip

# Create the ngrok config directory
RUN mkdir -p /root/.config/ngrok

# Copy ngrok config
COPY ngrok.yml /root/.config/ngrok/ngrok.yml

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE ${exposedPort}
CMD ["/start.sh"]
`;
                break;
            case "reactjs":
                appStartCommand = `serve -s build -l ${exposedPort}`;
                dockerfile = `
FROM ${baseImage}
WORKDIR /app
COPY package.json ./
RUN if ! command -v yarn; then npm install -g yarn; fi
RUN yarn install
RUN node -e "let p=require('./package.json'); if(!p.scripts.build) { p.scripts.build='react-scripts build'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)) }"
COPY . .
RUN yarn run build
RUN npm install -g serve

# Install ngrok
RUN apk add --no-cache curl unzip
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip

# Create the ngrok config directory
RUN mkdir -p /root/.config/ngrok

# Copy ngrok config
COPY ngrok.yml /root/.config/ngrok/ngrok.yml

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE ${exposedPort}
CMD ["/start.sh"]
`;
                break;
            case "vuejs":
                appStartCommand = `serve -s dist -l ${exposedPort}`;
                dockerfile = `
FROM ${baseImage}
WORKDIR /app
COPY package.json ./
RUN if ! command -v yarn; then npm install -g yarn; fi
RUN yarn install
RUN node -e "let p=require('./package.json'); if(!p.scripts.build) { p.scripts.build='vite build'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)) }"
COPY . .
RUN yarn run build
RUN npm install -g serve

# Install ngrok
RUN apk add --no-cache curl unzip
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip

# Create the ngrok config directory
RUN mkdir -p /root/.config/ngrok

# Copy ngrok config
COPY ngrok.yml /root/.config/ngrok/ngrok.yml

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE ${exposedPort}
CMD ["/start.sh"]
`;
                break;
            case "angularjs":
                appStartCommand = `serve -s dist/angular/browser -l ${exposedPort}`;
                dockerfile = `
FROM ${baseImage}
WORKDIR /app
COPY package.json ./
RUN npm install -g @angular/cli
RUN npm install
RUN node -e "let p=require('./package.json'); if(!p.scripts.build) { p.scripts.build='ng build'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)) }"
COPY . .
RUN npm run build
RUN npm install -g serve

# Install ngrok
RUN apk add --no-cache curl unzip
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip

# Create the ngrok config directory
RUN mkdir -p /root/.config/ngrok

# Copy ngrok config
COPY ngrok.yml /root/.config/ngrok/ngrok.yml

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE ${exposedPort}
CMD ["/start.sh"]
`;
                break;
            case "html":
                appStartCommand = `http-server . -p ${exposedPort}`;
                dockerfile = `
FROM ${baseImage}
WORKDIR /app
RUN npm install -g http-server
COPY . .

# Install ngrok
RUN apk add --no-cache curl unzip
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip

# Create the ngrok config directory
RUN mkdir -p /root/.config/ngrok

# Copy ngrok config
COPY ngrok.yml /root/.config/ngrok/ngrok.yml

# Startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE ${exposedPort}
CMD ["/start.sh"]
`;
                break;
        }

        // Write Dockerfile
        fs.writeFileSync(`${projectPath}/Dockerfile`, dockerfile);

        // Create startup script
        const startScript = createStartupScript('/root/.config/ngrok/ngrok.yml', appStartCommand);
        fs.writeFileSync(`${projectPath}/start.sh`, startScript);

        sendProgress(sessionId, 50, "Building Docker image...");
        const buildStream = await docker.buildImage(
            {
                context: projectPath,
                src: fs.readdirSync(projectPath),
            },
            { t: containerName }
        );

        let buildLogs = "";
        buildStream.on("data", (data) => {
            try {
                const log = JSON.parse(data.toString());
                if (log.stream) {
                    buildLogs += log.stream;
                    if (log.stream.includes("Step") && log.stream.includes("of")) {
                        const step = log.stream.match(/Step (\d+)\/(\d+)/);
                        if (step && step.length >= 3) {
                            const current = parseInt(step[1]);
                            const total = parseInt(step[2]);
                            const percentage = Math.floor((current / total) * 30) + 50;
                            sendProgress(
                                sessionId,
                                percentage,
                                `Building image: Step ${current}/${total}`
                            );
                        }
                    }
                }
            } catch (error) {
                buildLogs += data.toString();
            }
        });

        await new Promise((resolve, reject) => {
            buildStream.on("end", resolve);
            buildStream.on("error", (error) => {
                console.error("Error building Docker image:", error);
                reject(error);
            });
        });

        sendProgress(sessionId, 85, "Creating and starting container...");
        try {
            const container = await docker.createContainer({
                Image: containerName,
                name: containerName,
                ExposedPorts: { [`${exposedPort}/tcp`]: {} },
                HostConfig: {
                    PortBindings: {
                        [`${exposedPort}/tcp`]: [{ HostPort: exposedPort.toString() }],
                    },
                },
                Env: [`PORT=${exposedPort}`],
            });

            await container.start();

            sendProgress(sessionId, 100, "Deployment complete!");
            return res.status(200).json({
                message: `Project is running at https://${appDomain}`,
                url: `https://${appDomain}`,
            });
        } catch (error) {
            console.error("Error starting container:", error);
            return res.status(500).json({
                error: await cleanupContainer(
                    containerName,
                    sessionId,
                    "Failed to start container: " + error.message
                ),
            });
        }
    } catch (error) {
        console.error("Error during upload process:", error);
        return res.status(500).json({
            error: "An error occurred during upload: " + error.message,
        });
    }
}

app.post("/upload", upload.none(), async (req, res) => {
    const { language } = req.body;

    if (language === "mongodb") {
        return deployMongoDB(req, res);
    } else {
        return deployApplication(req, res);
    }
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`WebSocket server is running on ws://localhost:${PORT}`);

    if (!NGROK_AUTHTOKEN) {
        console.warn("WARNING: NGROK_AUTHTOKEN is not set. Ngrok tunnels will not work.");
    }
});

process.on("SIGINT", async () => {
    console.log("Shutting down server...");
    console.log("Server shutdown complete");
    process.exit(0);
});