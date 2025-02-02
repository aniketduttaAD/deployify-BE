const express = require("express");
const http = require("http");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const Docker = require("dockerode");
const localtunnel = require("localtunnel");
const crypto = require("crypto");
const ngrok = require("ngrok");

const upload = multer({ dest: "uploads/" });
const PROJECTS_DIR = path.resolve(__dirname, "uploads");
const docker = new Docker();

const app = express();
const server = http.createServer(app);
const PORT = 5001;

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

const ensureMongoImageExists = async () => {
    try {
        console.log("Pulling MongoDB image...");
        const pullStream = await docker.pull("mongo:6.0");
        await new Promise((resolve, reject) => {
            docker.modem.followProgress(pullStream, (err, res) => {
                if (err) {
                    console.error("Error pulling MongoDB image:", err);
                    reject(new Error("Failed to pull MongoDB image."));
                } else {
                    console.log("MongoDB image pulled successfully.");
                    resolve();
                }
            });
        });
        await docker.getImage("mongo:6.0").inspect();
    } catch (err) {
        console.error("Error ensuring mongo image exists:", err);
        throw new Error("Failed to ensure MongoDB image.");
    }
};

const ensureMongoExpressImageExists = async () => {
    try {
        console.log("Pulling mongo-express image...");
        const pullStream = await docker.pull("mongo-express:latest");
        await new Promise((resolve, reject) => {
            docker.modem.followProgress(pullStream, (err, res) => {
                if (err) {
                    console.error("Error pulling mongo-express image:", err);
                    reject(new Error("Failed to pull mongo-express image."));
                } else {
                    console.log("mongo-express image pulled successfully.");
                    resolve();
                }
            });
        });
        await docker.getImage("mongo-express:latest").inspect();
    } catch (err) {
        console.error("Error ensuring mongo-express image exists:", err);
        throw new Error("Failed to ensure mongo-express image.");
    }
};

const getRandomPort = () => Math.floor(Math.random() * (40000 - 30000) + 30000);

app.post("/upload", upload.none(), async (req, res) => {
    const { projectName, files, language, runCommand } = req.body;

    if (language === "mongodb") {
        if (!projectName) {
            return res.status(400).json({ error: "Invalid request data." });
        }

        try {
            console.log("Step 1: Ensure MongoDB image exists.");
            await ensureMongoImageExists();

            const mongoPassword = crypto.randomBytes(16).toString("hex");

            console.log("Step 2: Create MongoDB container.");
            let container;
            try {
                container = await docker.createContainer({
                    Image: "mongo:6.0",
                    name: `deployify-${projectName}`,
                    Env: [
                        `MONGO_INITDB_ROOT_USERNAME=admin`,
                        `MONGO_INITDB_ROOT_PASSWORD=${mongoPassword}`,
                    ],
                    ExposedPorts: { "27017/tcp": {} },
                    HostConfig: {
                        PortBindings: { "27017/tcp": [{ HostPort: getRandomPort().toString() }] },
                    },
                });
                await container.start();
            } catch (error) {
                console.error("Error creating MongoDB container:", error);
                return res
                    .status(500)
                    .json({ error: "Failed to create MongoDB container." });
            }

            const containerInfo = await container.inspect();
            const containerPort =
                containerInfo.NetworkSettings.Ports["27017/tcp"][0].HostPort;

            console.log("MongoDB container started on port:", containerPort);

            console.log("Step 3: Create Ngrok Tunnel for MongoDB.");
            let ngrokUrl;
            try {
                ngrokUrl = await ngrok.connect({
                    proto: "tcp",
                    addr: containerPort,
                    region: "us",
                });
                console.log("Ngrok tunnel created:", ngrokUrl);
            } catch (err) {
                console.error("Error creating Ngrok tunnel:", err);
                return res.status(500).json({ error: "Ngrok tunnel creation failed." });
            }

            console.log("Step 4: Ensure mongo-express image exists.");
            await ensureMongoExpressImageExists();

            console.log("Step 5: Generate random container name for mongo-express.");
            const uniqueNumber = Math.floor(100000 + Math.random() * 900000);
            const mongoExpressName = `mongo-express-${uniqueNumber}`;
            const ngrokHost = ngrokUrl.split("://")[1];
            const mongoUri = `mongodb://admin:${mongoPassword}@${ngrokHost}/?authSource=admin`;
            console.log("Step 6: Create and start mongo-express container.");
            let mongoExpressContainer;
            try {
                const ngrokPort = ngrokUrl.split(":")[2];
                mongoExpressContainer = await docker.createContainer({
                    Image: "mongo-express:latest",
                    name: mongoExpressName,
                    Env: [
                        `ME_CONFIG_MONGODB_URL=${mongoUri}`,
                        `ME_CONFIG_MONGODB_ADMINUSERNAME=admin`,
                        `ME_CONFIG_MONGODB_ADMINPASSWORD=${mongoPassword}`,
                        // `ME_CONFIG_MONGODB_SERVER=${ngrokUrl.split("://")[1].split(":")[0]
                        // }`,
                        `ME_CONFIG_MONGODB_PORT=${ngrokPort}`,
                        `ME_CONFIG_BASICAUTH_USERNAME=admin`,
                        `ME_CONFIG_BASICAUTH_PASSWORD=${mongoPassword}`,
                    ],
                    ExposedPorts: { "8081/tcp": {} },
                    HostConfig: {
                        PortBindings: { "8081/tcp": [{ HostPort: "0" }] },
                    },
                });

                await mongoExpressContainer.start();
            } catch (error) {
                console.error("Error creating mongo-express container:", error);
                return res
                    .status(500)
                    .json({ error: "Failed to create mongo-express container." });
            }

            const mongoExpressContainerInfo = await mongoExpressContainer.inspect();
            const mongoExpressPort =
                mongoExpressContainerInfo.NetworkSettings.Ports["8081/tcp"][0].HostPort;

            console.log("mongo-express container started on port:", mongoExpressPort);

            console.log("Step 7: Create local tunnel for mongo-express.");

            let tunnel;
            try {
                tunnel = await localtunnel({ port: mongoExpressPort });
                console.log("Mongo Express accessible at:", tunnel.url);
            } catch (err) {
                console.error("Error creating tunnel for mongo-express:", err);
                return res
                    .status(500)
                    .json({ error: "Mongo Express URL generation failed." });
            }

            console.log("MongoDB is running at", ngrokUrl);
            console.log("Mongo Express is running at", tunnel.url);

            return res.status(200).json({
                message: "MongoDB and Mongo Express are successfully set up.",
                mongodbUrl: ngrokUrl,
                mongoExpressUrl: tunnel.url,
                username: "admin",
                password: mongoPassword,
            });
        } catch (error) {
            console.error("Error setting up MongoDB container:", error);
            return res.status(500).json({ error: "Failed to deploy MongoDB." });
        }
    } else {
        try {
            if (!projectName || !files || !Array.isArray(files) || !language) {
                return res.status(400).json({ error: "Invalid request data." });
            }

            const projectPath = `${PROJECTS_DIR}/${projectName}`;
            const containerName = `deployify-${projectName}`;

            const containers = await docker.listContainers({ all: true });
            const existingContainer = containers.find((c) =>
                c.Names.includes(`/${containerName}`)
            );
            if (existingContainer) {
                return res.status(400).json({
                    error: `Container '${containerName}' already exists. Please choose a different project name.`,
                });
            }
            const images = await docker.listImages();
            const existingImage = images.find(
                (img) =>
                    img.RepoTags && img.RepoTags.includes(`${containerName}:latest`)
            );
            if (existingImage) {
                return res.status(400).json({
                    error: `Docker image '${containerName}' already exists. Please choose a different project name.`,
                });
            }

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
                console.log(`Progress: ${Math.floor((completed / totalFiles) * 100)}%`);
            }

            console.log("Files uploaded, starting build...");

            let image, dockerfile, installCommand, defaultRunCommand, exposedPort;

            switch (language) {
                case "nodejs":
                    image = "node:23-alpine3.20";
                    installCommand = "npm install";
                    defaultRunCommand = runCommand || "node server.js";
                    exposedPort = getRandomPort();
                    dockerfile = `
                    FROM ${image}
                    WORKDIR /app
                    COPY . /app
                    RUN ${installCommand}
                    CMD ${JSON.stringify(defaultRunCommand.split(" "))}
                `;
                    break;
                case "python":
                    image = "python:3.13.1-alpine3.21";
                    installCommand = "pip install -r requirements.txt";
                    defaultRunCommand =
                        runCommand || "python manage.py runserver 0.0.0.0:8000";
                    exposedPort = getRandomPort();
                    dockerfile = `
                    FROM ${image}
                    WORKDIR /app
                    COPY . /app
                    RUN ${installCommand}
                    CMD ${JSON.stringify(defaultRunCommand.split(" "))}
                `;
                    break;
                case "php":
                    image = "php:8.2-cli";
                    installCommand = "composer install";
                    exposedPort = getRandomPort();
                    const runCommandParts = runCommand ? runCommand.split(" ") : [];
                    const scriptFileName = runCommandParts[1]?.trim() || "index.php";
                    dockerfile = `
                        FROM ${image}
                        WORKDIR /var/www/html
                        COPY . /var/www/html
                        RUN apt-get update && apt-get install -y \
                            libpng-dev \
                            libjpeg-dev \
                            libfreetype6-dev \
                            unzip && \
                            docker-php-ext-configure gd --with-freetype --with-jpeg && \
                            docker-php-ext-install gd && \
                            curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer && \
                            ${installCommand}
                        EXPOSE ${exposedPort}
                        CMD ["php", "-S", "0.0.0.0:${exposedPort}", "-t", "/var/www/html", "${scriptFileName}"]
                    `;
                    break;
                case "golang":
                    image = "golang:1.23.5-alpine3.21";
                    const fileName = runCommand
                        .substring(runCommand.lastIndexOf("/") + 1)
                        .trim();
                    installCommand = `go mod tidy && go build -o /tmp/${fileName} .`;
                    exposedPort = getRandomPort();
                    dockerfile = `
                    FROM ${image}
                    WORKDIR /app
                    COPY . /app
                    RUN ${installCommand}
                    EXPOSE ${exposedPort}
                    CMD ["/tmp/${fileName}"]
                `;
                    break;
                case "nextjs":
                    image = "node:23-alpine3.20";
                    exposedPort = getRandomPort();
                    dockerfile = `
                    FROM ${image}
                    WORKDIR /app
                    COPY package.json ./
                    RUN if ! command -v yarn; then npm install -g yarn; fi
                    RUN yarn install
                    RUN node -e "let p=require('./package.json'); if(!p.scripts.build) { p.scripts.build='next build'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)) }"
                    COPY . .
                    RUN yarn run build
                    EXPOSE ${exposedPort}
                    CMD ["yarn", "start"]
                `;
                    break;
                case "reactjs":
                    image = "node:23-alpine3.20";
                    exposedPort = getRandomPort();
                    dockerfile = `
                    FROM ${image}
                    WORKDIR /app
                    COPY package.json ./
                    RUN if ! command -v yarn; then npm install -g yarn; fi
                    RUN yarn install
                    RUN node -e "let p=require('./package.json'); if(!p.scripts.build) { p.scripts.build='react-scripts build'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)) }"
                    COPY . .
                    RUN yarn run build
                    RUN npm install -g serve
                    EXPOSE ${exposedPort}
                    CMD ["serve", "-s", "build"]
                    `;
                    break;
                case "vuejs":
                    image = "node:23-alpine3.20";
                    exposedPort = getRandomPort();
                    dockerfile = `
                    FROM ${image}
                    WORKDIR /app
                    COPY package.json ./
                    RUN if ! command -v yarn; then npm install -g yarn; fi
                    RUN yarn install
                    RUN node -e "let p=require('./package.json'); if(!p.scripts.build) { p.scripts.build='vite build'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)) }"
                    COPY . .
                    RUN yarn run build
                    RUN npm install -g serve
                       EXPOSE ${exposedPort}
                    CMD ["serve", "-s", "dist"]
                `;
                    break;
                case "angularjs":
                    image = "node:23-alpine3.20";
                    exposedPort = getRandomPort();
                    dockerfile = `
                    FROM ${image}
                    WORKDIR /app
                    COPY package.json ./
                    RUN npm install -g @angular/cli
                    RUN npm install
                    RUN node -e "let p=require('./package.json'); if(!p.scripts.build) { p.scripts.build='ng build'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)) }"
                    COPY . .
                    RUN npm run build
                    RUN npm install -g serve
                    EXPOSE ${exposedPort}
                    CMD ["serve", "-s", "dist/angular/browser"]
                `;
                    break;
                case "html":
                    image = "node:23-alpine3.20";
                    exposedPort = 8080;
                    dockerfile = `
                FROM ${image}
                WORKDIR /app
                RUN npm install -g http-server
                COPY . .
                EXPOSE ${exposedPort}
                CMD ["http-server", ".", "-p", "8080"]
            `;
                    break;
                default:
                    return res.status(400).json({ error: "Unsupported language." });
            }

            const dockerfilePath = path.join(projectPath, "Dockerfile");
            fs.writeFileSync(dockerfilePath, dockerfile);

            const buildStream = await docker.buildImage(
                {
                    context: projectPath,
                    src: ["Dockerfile", "."],
                },
                { t: containerName }
            );

            buildStream.on("data", (data) => {
                try {
                    const log = JSON.parse(data.toString());
                    if (log.stream) {
                        console.log(log.stream);
                    }
                } catch (error) {
                    console.log("Non-JSON data:", data.toString());
                }
            });

            buildStream.on("end", async () => {
                try {
                    const container = await docker.createContainer({
                        Image: containerName,
                        name: containerName,
                        ExposedPorts: { [`${exposedPort}/tcp`]: {} },
                        HostConfig: {
                            PortBindings: {
                                [`${exposedPort}/tcp`]: [{ HostPort: "0" }],
                            },
                        },
                        Env: [`PORT=${exposedPort}`],
                    });

                    await container.start();
                    const containerInfo = await container.inspect();
                    const containerPort =
                        containerInfo.NetworkSettings.Ports[`${exposedPort}/tcp`][0]
                            .HostPort;

                    let tunnel;
                    try {
                        tunnel = await localtunnel({ port: containerPort });
                    } catch (err) {
                        console.error("Error creating tunnel:", err);
                        return res.status(500).json({ error: "URL generation failed." });
                    }

                    console.log(`Project is running at ${tunnel.url}`);
                    res
                        .status(200)
                        .json({ message: `Project is running at ${tunnel.url}` });
                } catch (error) {
                    console.error("Error starting container:", error);
                    res
                        .status(500)
                        .json({ error: "An error occurred while starting the container." });
                }
            });

            buildStream.on("error", async (error) => {
                console.error("Error building Docker image:", error);
                res.status(500).json({ error: "Docker build failed." });
            });
        } catch (error) {
            console.error("Error during upload process:", error);
            res.status(500).json({ error: "An error occurred during upload." });
        }
    }
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
