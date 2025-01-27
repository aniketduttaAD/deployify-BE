//node /Users/aniketdutta/Documents/deployify-BE/app/index.js && lt --port 5001

const express = require('express');
const http = require('http');
const cors = require('cors');
const WebSocket = require('ws');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');
const localtunnel = require('localtunnel');

const upload = multer({ dest: 'uploads/' });
const PROJECTS_DIR = path.resolve(__dirname, 'uploads');
const docker = new Docker();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 5001;

app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

wss.on('connection', (ws) => {
    console.log('WebSocket connection established');
    ws.on('close', () => {
        console.log('WebSocket connection closed');
    });
});

app.use((req, res, next) => {
    req.wss = wss;
    next();
});

// Health check route
app.get('/health', (req, res) => {
    res.status(200).json({ message: 'Server is running' });
});

// Helper function to clean up resources
async function cleanupResources(projectPath, containerName) {
    try {
        // Remove project files
        if (fs.existsSync(projectPath)) {
            fs.rmSync(projectPath, { recursive: true, force: true });
        }

        // Stop and remove the container if it exists
        const container = docker.getContainer(containerName);
        if (container) {
            try {
                await container.stop();
            } catch (e) {
                console.warn(`Container ${containerName} was not running.`);
            }
            await container.remove();
        }

        // Remove the Docker image
        await docker.getImage(containerName).remove();
    } catch (err) {
        console.error(`Error during cleanup for ${containerName}:`, err);
    }
}

app.post('/projects/upload', upload.none(), async (req, res) => {
    const ws = req.wss.clients.values().next().value;
    try {
        const { projectName, files, runCommand = 'node server.js' } = req.body;

        if (!projectName || !files || !Array.isArray(files)) {
            return res.status(400).json({ error: 'Invalid request data.' });
        }

        const projectPath = `${PROJECTS_DIR}/${projectName}`;
        const containerName = `deployify-${projectName}`;
        fs.mkdirSync(projectPath, { recursive: true });

        let completed = 0;
        const totalFiles = files.length;

        for (const file of files) {
            const { path: filePath, content } = file;
            const fullPath = path.join(projectPath, filePath);
            const dir = path.dirname(fullPath);

            fs.mkdirSync(dir, { recursive: true });

            if (content) {
                let fileContent = Buffer.from(content, 'base64').toString();

                if (filePath === 'server.js' || filePath.endsWith('.js')) {
                    const newPort = 'process.env.PORT || 8080';
                    fileContent = fileContent.replace(/const\s+PORT\s*=\s*\d+;/, `const PORT = ${newPort};`);
                }

                fs.writeFileSync(fullPath, fileContent);
            }

            completed++;
            if (ws && ws.readyState === WebSocket.OPEN) {
                const progress = Math.floor((completed / totalFiles) * 100);
                ws.send(JSON.stringify({ status: 'progress', progress }));
            }
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ status: 'progress', progress: 100, message: 'Files uploaded, starting build...' }));
        }

        const image = 'node:alpine';

        const dockerfile = `
            FROM ${image}
            WORKDIR /app
            COPY . /app
            RUN npm install
            CMD ${JSON.stringify(runCommand.split(' '))}
        `;
        const dockerfilePath = path.join(projectPath, 'Dockerfile');
        fs.writeFileSync(dockerfilePath, dockerfile);

        const buildStream = await docker.buildImage({
            context: projectPath,
            src: ['Dockerfile', '.']
        }, { t: containerName });

        buildStream.on('data', (data) => {
            try {
                const log = JSON.parse(data.toString());
                if (log.stream) {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ status: 'progress', message: log.stream }));
                    }
                }
            } catch (error) {
                console.log('Non-JSON data:', data.toString());
            }
        });

        buildStream.on('end', async () => {
            try {
                const container = await docker.createContainer({
                    Image: containerName,
                    name: containerName,
                    ExposedPorts: { '8080/tcp': {} },
                    HostConfig: {
                        PortBindings: {
                            '8080/tcp': [{ HostPort: '0' }]
                        }
                    },
                    Env: ['PORT=8080'],
                });

                await container.start();
                const containerInfo = await container.inspect();
                const containerPort = containerInfo.NetworkSettings.Ports['8080/tcp'][0].HostPort;

                let tunnel;
                try {
                    tunnel = await localtunnel({ port: containerPort });
                } catch (err) {
                    console.error('Error creating tunnel:', err);
                    await cleanupResources(projectPath, containerName);
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ status: 'error', message: 'URL generation failed. Resources cleaned up.' }));
                    }
                    return res.status(500).json({ error: 'URL generation failed.' });
                }

                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ status: 'success', message: `Project is running at ${tunnel.url}` }));
                }

                res.status(200).json({ message: `Project is running at ${tunnel.url}` });

            } catch (error) {
                console.error('Error starting container:', error);
                await cleanupResources(projectPath, containerName);

                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ status: 'error', error: 'Build failed. Resources cleaned up.' }));
                }

                res.status(500).json({ error: 'An error occurred while starting the container.' });
            }
        });

        buildStream.on('error', async (error) => {
            console.error('Error building Docker image:', error);
            await cleanupResources(projectPath, containerName);

            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ status: 'error', error: 'Docker build failed. Resources cleaned up.' }));
            }

            res.status(500).json({ error: 'Docker build failed.' });
        });

    } catch (error) {
        console.error('Error during upload process:', error);
        await cleanupResources(PROJECTS_DIR, `deployify-${projectName}`);

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ status: 'error', error: 'An error occurred during upload. Resources cleaned up.' }));
        }

        res.status(500).json({ error: 'An error occurred during upload.' });
    }
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
