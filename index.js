const express = require("express");
const http = require("http");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const Docker = require("dockerode");
const localtunnel = require("localtunnel");

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

async function cleanupResources(projectPath, containerName) {
    try {
        if (fs.existsSync(projectPath)) {
            fs.rmSync(projectPath, { recursive: true, force: true });
        }
        const container = docker.getContainer(containerName);
        if (container) {
            try {
                await container.stop();
            } catch (e) {
                console.warn(`Container ${containerName} was not running.`);
            }
            await container.remove();
        }
        try {
            await docker.getImage(containerName).remove();
        } catch (e) {
            console.warn(`Image ${containerName} was not available`);
        }
    } catch (err) {
        console.error(`Error during cleanup for ${containerName}:`, err);
    }
}

app.post("/upload", upload.none(), async (req, res) => {
    try {
        const { projectName, files, language, runCommand } = req.body;

        if (!projectName || !files || !Array.isArray(files) || !language) {
            return res.status(400).json({ error: "Invalid request data." });
        }

        const projectPath = `${PROJECTS_DIR}/${projectName}`;
        const containerName = `deployify-${projectName}`;

        const containers = await docker.listContainers({ all: true });
        const existingContainer = containers.find(c =>
            c.Names.includes(`/${containerName}`)
        );
        if (existingContainer) {
            return res.status(400).json({ error: `Container '${containerName}' already exists. Please choose a different project name.` });
        }
        const images = await docker.listImages();
        const existingImage = images.find(img =>
            img.RepoTags && img.RepoTags.includes(`${containerName}:latest`)
        );
        if (existingImage) {
            return res.status(400).json({ error: `Docker image '${containerName}' already exists. Please choose a different project name.` });
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
                exposedPort = 8080;
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
                exposedPort = 8000;
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
                exposedPort = 80;
                const runCommandParts = runCommand.split(" ");
                const scriptFileName = runCommandParts[1]?.trim();
                dockerfile = `
                        FROM ${image}
                        WORKDIR /var/www/html
                        COPY . /var/www/html
                        RUN apt-get update && apt-get install -y \
                            libpng-dev \
                            libjpeg-dev \
                            libfreetype6-dev && \
                            docker-php-ext-configure gd --with-freetype --with-jpeg && \
                            docker-php-ext-install gd && \
                            curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer && \
                            ${installCommand}
                        EXPOSE ${exposedPort}
                        CMD ["php", "-S", "0.0.0.0:80", "${scriptFileName}"]
                    `;
                break;
            case "golang":
                image = "golang:1.23.5-alpine3.21";
                const fileName = runCommand
                    .substring(runCommand.lastIndexOf("/") + 1)
                    .trim();
                installCommand = `go mod tidy && go build -o /tmp/${fileName} .`;
                exposedPort = 8080;
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
                exposedPort = 3000;
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
                exposedPort = 3000;
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
                exposedPort = 5000;
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
                    CMD ["serve", "-s", "build"]
                `;
                break;
            case "angularjs":
                image = "node:23-alpine3.20";
                exposedPort = 5000;
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
                    containerInfo.NetworkSettings.Ports[`${exposedPort}/tcp`][0].HostPort;

                let tunnel;
                try {
                    tunnel = await localtunnel({ port: containerPort });
                } catch (err) {
                    console.error("Error creating tunnel:", err);
                    await cleanupResources(projectPath, containerName);
                    return res.status(500).json({ error: "URL generation failed." });
                }

                console.log(`Project is running at ${tunnel.url}`);
                res.status(200).json({ message: `Project is running at ${tunnel.url}` });
            } catch (error) {
                console.error("Error starting container:", error);
                await cleanupResources(projectPath, containerName);
                res.status(500).json({ error: "An error occurred while starting the container." });
            }
        });

        buildStream.on("error", async (error) => {
            console.error("Error building Docker image:", error);
            res.status(500).json({ error: "Docker build failed." });
        });
    } catch (error) {
        console.error("Error during upload process:", error);
        await cleanupResources(PROJECTS_DIR, `deployify-${projectName}`);
        res.status(500).json({ error: "An error occurred during upload." });
    }
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
