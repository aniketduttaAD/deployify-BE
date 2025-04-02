const fs = require("fs");
const path = require("path");
const { PROJECTS_DIR, NGROK_AUTHTOKEN } = require("../config");
const { sendProgress } = require("./progressService");
const { ensureImageExists, cleanupContainer, docker, buildImageWithRetry, createAndStartContainer } = require("./dockerService");
const { createNgrokReservedDomain, createNgrokReservedAddress, generateNgrokConfig } = require("./ngrokService");
const { getAvailablePort } = require("../utils");

async function deployApplication(req, res) {
    const { projectName, files, language, runCommand } = req.body;
    const sessionId = req.query.sessionId;
    const isMongoDB = language === "mongodb";

    if (!NGROK_AUTHTOKEN) {
        return res.status(500).json({ error: "Missing ngrok auth token configuration." });
    }

    try {
        if (!projectName || !files || !Array.isArray(files) || !language) {
            return res.status(400).json({ error: "Invalid request data." });
        }

        const projectPath = path.join(PROJECTS_DIR, projectName);
        const containerName = `deployify-${projectName}`;

        const containers = await docker.listContainers({ all: true });
        if (containers.some(c => c.Names.includes(`/${containerName}`))) {
            return res.status(400).json({
                error: `Container '${containerName}' already exists. Please choose a different project name.`,
            });
        }

        // Step 1: Generate a random port
        sendProgress(sessionId, 5, "Generating container port...");
        const containerPort = await getAvailablePort();

        // Step 2: Create Ngrok endpoint
        sendProgress(sessionId, 10, "Creating Ngrok endpoint...");
        let ngrokEndpoint;
        let ngrokConfig;

        if (isMongoDB) {
            ngrokEndpoint = await createNgrokReservedAddress();
            ngrokConfig = generateNgrokConfig(NGROK_AUTHTOKEN, {
                name: projectName,
                type: 'tcp',
                url: ngrokEndpoint,
                port: containerPort
            });
        } else {
            const subdomain = `deployify-${projectName}`;
            ngrokEndpoint = await createNgrokReservedDomain(subdomain);
            ngrokConfig = generateNgrokConfig(NGROK_AUTHTOKEN, {
                name: projectName,
                type: 'http',
                url: ngrokEndpoint,
                port: containerPort
            });
        }

        // Create project directory and save files
        sendProgress(sessionId, 15, "Creating project directory...");
        fs.mkdirSync(projectPath, { recursive: true });
        fs.writeFileSync(path.join(projectPath, "ngrok.yml"), ngrokConfig);

        // Process files and detect user port
        let detectedPort = null;
        const portPatterns = [
            /ListenAndServe\(\s*"(:|0\.0\.0\.0:)(\d+)"\s*,/,
            /\.listen\(\s*(\d+)/,
            /PORT\s*=\s*(\d+)/i,
            /port\s*=\s*(\d+)/i,
            /runserver\s+0\.0\.0\.0:(\d+)/,
            /-p\s+(\d+)/,
            /\bport:\s*(\d+)/i,
        ];

        // For Next.js specific detection
        let isNextProject = false;
        let nextConfigContent = null;

        for (let i = 0; i < files.length; i++) {
            const { path: filePath, content } = files[i];
            const fullPath = path.join(projectPath, filePath);
            const dir = path.dirname(fullPath);

            fs.mkdirSync(dir, { recursive: true });

            if (content) {
                const fileContent = Buffer.from(content, "base64").toString();

                // Check for Next.js project
                if (filePath === 'package.json' && fileContent.includes('"next"')) {
                    isNextProject = true;
                }

                // Save Next.js config content if found
                if (filePath === 'next.config.js') {
                    nextConfigContent = fileContent;
                }

                if (!detectedPort) {
                    for (const pattern of portPatterns) {
                        const match = fileContent.match(pattern);
                        if (match && match[1]) {
                            const port = parseInt(match[1], 10);
                            if (port > 0 && port < 65536) {
                                detectedPort = port;
                                break;
                            }
                        }
                    }
                }

                fs.writeFileSync(fullPath, fileContent);
            }

            sendProgress(sessionId, Math.floor(15 + (i + 1) / files.length * 15), `Processing file ${i + 1}/${files.length}`);
        }

        // Default internal port if none detected
        const internalPort = detectedPort || 3000;

        // Modify the Next.js config if needed
        if (isNextProject) {
            if (nextConfigContent) {
                // Update Next.js config to use the internal port
                const updatedConfig = nextConfigContent.replace(
                    /module\.exports\s*=\s*{/,
                    `module.exports = {\n  experimental: { outputStandalone: true },\n  env: { PORT: '${internalPort}' },`
                );
                fs.writeFileSync(path.join(projectPath, 'next.config.js'), updatedConfig);
            } else {
                // Create Next.js config if it doesn't exist
                const nextConfig = `
module.exports = {
  experimental: { outputStandalone: true },
  env: { PORT: '${internalPort}' }
}`;
                fs.writeFileSync(path.join(projectPath, 'next.config.js'), nextConfig);
            }
        }

        // Configure container based on language
        const config = getLanguageConfig(language, internalPort, containerPort, runCommand);

        // Create Dockerfile and startup script
        fs.writeFileSync(
            path.join(projectPath, "Dockerfile"),
            createDockerfile(config, containerPort, internalPort)
        );

        fs.writeFileSync(
            path.join(projectPath, "start.sh"),
            createStartupScript(internalPort, containerPort, config.startCommand)
        );

        // Build and run the container
        sendProgress(sessionId, 40, `Preparing Docker environment for ${language}...`);
        await ensureImageExists(config.baseImage);

        sendProgress(sessionId, 50, "Building Docker image...");
        await buildImageWithRetry(
            { context: projectPath, src: fs.readdirSync(projectPath) },
            { t: containerName }
        );

        // Verify image was built
        const images = await docker.listImages();
        if (!images.some(img => img.RepoTags && img.RepoTags.includes(`${containerName}:latest`))) {
            sendProgress(sessionId, 0, "Error: Image build failed");
            return res.status(500).json({ error: "Docker image build failed" });
        }

        // Create and start the container
        sendProgress(sessionId, 85, "Creating and starting container...");
        const containerResult = await createAndStartContainer({
            containerName,
            exposedPort: containerPort,
            image: containerName,
            env: [
                `PORT=${internalPort}`,  // This is critical - apps should use this PORT env var
                `INTERNAL_PORT=${internalPort}`,
                `CONTAINER_PORT=${containerPort}`,
                `NGROK_AUTHTOKEN=${NGROK_AUTHTOKEN}`
            ]
        });

        // Send success response
        sendProgress(sessionId, 100, `Deployment complete! Container is ${containerResult.status}`);
        return res.status(200).json({
            message: `Application deployed successfully`,
            url: isMongoDB ? ngrokEndpoint : `https://${ngrokEndpoint}`,
            internalPort,
            exposedPort: containerPort
        });
    } catch (error) {
        return res.status(500).json({
            error: `Deployment failed: ${error.message}`
        });
    }
}

function getLanguageConfig(language, internalPort, containerPort, runCommand) {
    const configs = {
        nodejs: {
            baseImage: "node:23-alpine3.20",
            installCommand: "npm install",
            startCommand: runCommand || "node server.js",
            isAlpine: true
        },
        python: {
            baseImage: "python:3.13.1-alpine3.21",
            installCommand: "pip install -r requirements.txt",
            startCommand: runCommand || `python manage.py runserver 0.0.0.0:${internalPort}`,
            isAlpine: true
        },
        php: {
            baseImage: "php:8.2-cli",
            installCommand: "composer install",
            startCommand: `php -S 0.0.0.0:${internalPort} -t /var/www/html ${(runCommand ? runCommand.split(" ")[1] : null) || "index.php"}`,
            isAlpine: false
        },
        golang: {
            baseImage: "golang:1.23.5-alpine3.21",
            installCommand: "go mod download && go build -o /app/app .",
            startCommand: "/app/app",
            isAlpine: true
        },
        nextjs: {
            baseImage: "node:23-alpine3.20",
            installCommand: "yarn install && yarn build",
            startCommand: `PORT=${internalPort} yarn start`,
            isAlpine: true,
            useYarn: true
        },
        reactjs: {
            baseImage: "node:23-alpine3.20",
            installCommand: "yarn install && yarn build && npm install -g serve",
            startCommand: `serve -s build -l ${internalPort}`,
            isAlpine: true,
            useYarn: true
        },
        vuejs: {
            baseImage: "node:23-alpine3.20",
            installCommand: "yarn install && yarn build && npm install -g serve",
            startCommand: `serve -s dist -l ${internalPort}`,
            isAlpine: true,
            useYarn: true
        },
        angularjs: {
            baseImage: "node:23-alpine3.20",
            installCommand: "npm install -g @angular/cli && npm install && npm run build && npm install -g serve",
            startCommand: `serve -s dist/angular/browser -l ${internalPort}`,
            isAlpine: true
        },
        html: {
            baseImage: "node:23-alpine3.20",
            installCommand: "npm install -g http-server",
            startCommand: `http-server . -p ${internalPort}`,
            isAlpine: true
        },
        mongodb: {
            baseImage: "mongo:7.0.5",
            installCommand: "",
            startCommand: `mongod --bind_ip 0.0.0.0 --port ${internalPort}`,
            isAlpine: false
        }
    };

    const config = configs[language] || configs.nodejs;
    config.setupTools = config.isAlpine
        ? "apk add --no-cache curl unzip socat"
        : "apt-get update && apt-get install -y curl unzip socat";

    return config;
}

function createDockerfile(config, containerPort, internalPort) {
    const yarnSetup = config.useYarn ? "RUN if ! command -v yarn; then npm install -g yarn; fi" : "";
    const installCmd = config.installCommand ? `RUN ${config.installCommand}` : "";

    return `FROM ${config.baseImage}
WORKDIR /app
COPY . /app
${yarnSetup}
${installCmd}
ENV PORT=${internalPort}
ENV INTERNAL_PORT=${internalPort}
ENV CONTAINER_PORT=${containerPort}

RUN ${config.setupTools}

RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip
RUN mkdir -p /root/.config/ngrok
COPY ngrok.yml /root/.config/ngrok/ngrok.yml
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE ${internalPort}
EXPOSE ${containerPort}
CMD ["/start.sh"]`;
}

function createStartupScript(internalPort, containerPort, startCommand) {
    return `#!/bin/sh
# Start ngrok in the background
/usr/local/bin/ngrok start --config /root/.config/ngrok/ngrok.yml --all &
NGROK_PID=$!

# Set up port forwarding from container port to internal port
if [ "$INTERNAL_PORT" != "$CONTAINER_PORT" ]; then
  echo "Setting up port forwarding from $CONTAINER_PORT to $INTERNAL_PORT"
  socat TCP-LISTEN:$CONTAINER_PORT,fork TCP:localhost:$INTERNAL_PORT &
  SOCAT_PID=$!
fi

# Start the application on internal port only
echo "Starting application on port $INTERNAL_PORT"
export PORT=$INTERNAL_PORT
${startCommand} &
APP_PID=$!

# Handle graceful shutdown
trap 'kill $APP_PID $NGROK_PID $SOCAT_PID 2>/dev/null; exit' SIGINT SIGTERM
wait $APP_PID
`;
}

module.exports = { deployApplication };