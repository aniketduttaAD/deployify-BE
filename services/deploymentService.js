const fs = require("fs");
const path = require("path");
const { PROJECTS_DIR, NGROK_AUTHTOKEN } = require("../config");
const { sendProgress } = require("./progressService");
const { ensureImageExists, cleanupContainer, docker, buildImageWithRetry, createAndStartContainer } = require("./dockerService");
const { createNgrokReservedDomain, generateNgrokConfig } = require("./ngrokService");
const { getAvailablePort, createStartupScript } = require("../utils");

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
        if (containers.some(c => c.Names.includes(`/${containerName}`))) {
            return res.status(400).json({
                error: `Container '${containerName}' already exists. Please choose a different project name.`,
            });
        }

        sendProgress(sessionId, 5, "Creating project directory...");
        fs.mkdirSync(projectPath, { recursive: true });

        let completed = 0;
        const totalFiles = files.length;

        // Try to detect user-specified port in files
        let detectedUserPort = null;

        for (const file of files) {
            const { path: filePath, content } = file;
            const fullPath = path.join(projectPath, filePath);
            const dir = path.dirname(fullPath);

            fs.mkdirSync(dir, { recursive: true });

            if (content) {
                let fileContent = Buffer.from(content, "base64").toString();

                // Look for port patterns in the code
                const portPatterns = [
                    /ListenAndServe\(\s*"(:|0\.0\.0\.0:)(\d+)"\s*,/,            // Go
                    /\.listen\(\s*(\d+)/,                                        // Node.js
                    /PORT\s*=\s*(\d+)/i,                                         // Common env var
                    /port\s*=\s*(\d+)/i,                                         // Common variable assignment
                    /runserver\s+0\.0\.0\.0:(\d+)/,                              // Django
                    /-p\s+(\d+)/,                                                // Command line arg
                    /\bport:\s*(\d+)/i,                                          // Config object
                ];

                for (const pattern of portPatterns) {
                    const match = fileContent.match(pattern);
                    if (match && match[1]) {
                        const foundPort = parseInt(match[1], 10);
                        if (foundPort > 0 && foundPort < 65536) {
                            detectedUserPort = foundPort;
                            console.log(`Detected user-specified port: ${detectedUserPort} in file ${filePath}`);
                            break;
                        }
                    }
                }

                fs.writeFileSync(fullPath, fileContent);
            }

            sendProgress(sessionId, Math.floor((++completed / totalFiles) * 20) + 5, `Processing file ${completed}/${totalFiles}`);
        }

        if (language === "golang" && !files.some(f => f.path === "go.mod")) {
            const moduleName = `github.com/deployify/${projectName}`;
            const goModContent = `module ${moduleName}\n\ngo 1.23\n`;
            fs.writeFileSync(path.join(projectPath, "go.mod"), goModContent);
            sendProgress(sessionId, Math.floor((completed / totalFiles) * 20) + 5, `Created missing go.mod file`);
        }

        sendProgress(sessionId, 30, "Preparing Docker environment...");

        let baseImage, installCommand, defaultRunCommand;

        switch (language) {
            case "nodejs":
                baseImage = "node:23-alpine3.20";
                installCommand = "npm install";
                defaultRunCommand = runCommand || "node server.js";
                break;
            case "python":
                baseImage = "python:3.13.1-alpine3.21";
                installCommand = "pip install -r requirements.txt";
                defaultRunCommand = runCommand || "python manage.py runserver 0.0.0.0:8000";
                break;
            case "php":
                baseImage = "php:8.2-cli";
                installCommand = "composer install";
                break;
            case "golang":
                baseImage = "golang:1.23.5-alpine3.21";
                installCommand = "go mod download && go build -o /app/app .";
                defaultRunCommand = "/app/app";
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

        // Get a random available port for external access
        const exposedPort = await getAvailablePort();

        // Default to 8080 as internal port if none detected
        const internalPort = detectedUserPort || 8080;

        sendProgress(sessionId, 40, "Creating Ngrok domain...");
        let appDomain;
        try {
            const subdomain = `deployify-${projectName}.ngrok.app`;
            const reservedDomain = await createNgrokReservedDomain(subdomain);
            appDomain = reservedDomain.domain;
        } catch (err) {
            return res.status(500).json({
                error: "Failed to create Ngrok domain: " + err.message
            });
        }

        // Configure ngrok to use exposedPort
        const ngrokConfigContent = generateNgrokConfig(NGROK_AUTHTOKEN, 'http', {
            domain: appDomain,
            port: exposedPort
        });
        fs.writeFileSync(`${projectPath}/ngrok.yml`, ngrokConfigContent);

        sendProgress(sessionId, 45, "Creating Dockerfile...");
        let dockerfile, appStartCommand;

        // We'll use socat to handle port forwarding if needed
        const createAlpineDockerfile = () => `
FROM ${baseImage}
WORKDIR /app
COPY . /app
RUN ${installCommand}
ENV PORT=${exposedPort}
ENV INTERNAL_PORT=${internalPort}
RUN apk add --no-cache curl unzip socat

# Install ngrok
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip
RUN mkdir -p /root/.config/ngrok
COPY ngrok.yml /root/.config/ngrok/ngrok.yml
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE ${exposedPort}
CMD ["/start.sh"]`;

        const createDebianDockerfile = () => `
FROM ${baseImage}
WORKDIR /app
COPY . /app
RUN ${installCommand}
ENV PORT=${exposedPort}
ENV INTERNAL_PORT=${internalPort}
RUN apt-get update && apt-get install -y curl unzip socat

# Install ngrok
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip
RUN mkdir -p /root/.config/ngrok
COPY ngrok.yml /root/.config/ngrok/ngrok.yml
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE ${exposedPort}
CMD ["/start.sh"]`;

        switch (language) {
            case "nodejs":
                appStartCommand = defaultRunCommand;
                dockerfile = createAlpineDockerfile();
                break;
            case "python":
                appStartCommand = defaultRunCommand;
                dockerfile = createAlpineDockerfile();
                break;
            case "php":
                const phpScriptFileName = (runCommand ? runCommand.split(" ")[1] : null) || "index.php";
                appStartCommand = `php -S 0.0.0.0:${internalPort} -t /var/www/html ${phpScriptFileName}`;
                dockerfile = createDebianDockerfile();
                break;
            case "golang":
                appStartCommand = defaultRunCommand;
                dockerfile = createAlpineDockerfile();
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
ENV INTERNAL_PORT=${internalPort}
RUN apk add --no-cache curl unzip socat
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip
RUN mkdir -p /root/.config/ngrok
COPY ngrok.yml /root/.config/ngrok/ngrok.yml
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE ${exposedPort}
CMD ["/start.sh"]`;
                break;
            case "reactjs":
                appStartCommand = `serve -s build -l ${internalPort}`;
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
ENV PORT=${exposedPort}
ENV INTERNAL_PORT=${internalPort}
RUN apk add --no-cache curl unzip socat
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip
RUN mkdir -p /root/.config/ngrok
COPY ngrok.yml /root/.config/ngrok/ngrok.yml
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE ${exposedPort}
CMD ["/start.sh"]`;
                break;
            case "vuejs":
                appStartCommand = `serve -s dist -l ${internalPort}`;
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
ENV PORT=${exposedPort}
ENV INTERNAL_PORT=${internalPort}
RUN apk add --no-cache curl unzip socat
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip
RUN mkdir -p /root/.config/ngrok
COPY ngrok.yml /root/.config/ngrok/ngrok.yml
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE ${exposedPort}
CMD ["/start.sh"]`;
                break;
            case "angularjs":
                appStartCommand = `serve -s dist/angular/browser -l ${internalPort}`;
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
ENV PORT=${exposedPort}
ENV INTERNAL_PORT=${internalPort}
RUN apk add --no-cache curl unzip socat
RUN curl -L -o ngrok.zip https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.zip && \\
    unzip ngrok.zip -d /usr/local/bin && \\
    rm ngrok.zip
RUN mkdir -p /root/.config/ngrok
COPY ngrok.yml /root/.config/ngrok/ngrok.yml
COPY start.sh /start.sh
RUN chmod +x /start.sh
EXPOSE ${exposedPort}
CMD ["/start.sh"]`;
                break;
            case "html":
                appStartCommand = `http-server . -p ${internalPort}`;
                dockerfile = createAlpineDockerfile();
                break;
        }

        fs.writeFileSync(`${projectPath}/Dockerfile`, dockerfile);

        // Create a modified startup script that handles port forwarding if needed
        const startScript = `#!/bin/sh
# Start ngrok in the background
/usr/local/bin/ngrok start --config /root/.config/ngrok/ngrok.yml --all &

# If the exposed port and internal port are different, set up port forwarding
if [ "$PORT" != "$INTERNAL_PORT" ]; then
  echo "Setting up port forwarding from $PORT to $INTERNAL_PORT"
  socat TCP-LISTEN:$PORT,fork TCP:localhost:$INTERNAL_PORT &
fi

# Start the application
echo "Starting application on port $INTERNAL_PORT"
${appStartCommand}
`;

        fs.writeFileSync(`${projectPath}/start.sh`, startScript);

        sendProgress(sessionId, 50, "Building Docker image...");

        try {
            await buildImageWithRetry(
                { context: projectPath, src: fs.readdirSync(projectPath) },
                { t: containerName }
            );

            const images = await docker.listImages();
            const imageExists = images.some(img =>
                img.RepoTags && img.RepoTags.includes(`${containerName}:latest`)
            );

            if (!imageExists) {
                sendProgress(sessionId, 0, `Error: Image build failed. Check the project files.`);
                return res.status(500).json({
                    error: "Docker image build failed. Please check your project files."
                });
            }

            sendProgress(sessionId, 85, "Creating and starting container...");
            try {
                // Create and start the container using our enhanced function
                const containerResult = await createAndStartContainer({
                    containerName,
                    exposedPort,
                    image: containerName,
                    env: [`PORT=${exposedPort}`, `INTERNAL_PORT=${internalPort}`]
                });

                sendProgress(sessionId, 100, `Deployment complete! Container status: ${containerResult.status}`);
                return res.status(200).json({
                    message: `Application deployed successfully. Container ID: ${containerResult.id}`,
                    url: `https://${appDomain}`,
                    internalPort,
                    exposedPort
                });
            } catch (error) {
                return res.status(500).json({
                    error: await cleanupContainer(
                        containerName,
                        sessionId,
                        "Failed to start container: " + error.message
                    ),
                });
            }
        } catch (buildError) {
            return res.status(500).json({
                error: "Failed to build Docker image: " + buildError.message
            });
        }
    } catch (error) {
        return res.status(500).json({
            error: "An error occurred during upload: " + error.message,
        });
    }
}

module.exports = { deployApplication };