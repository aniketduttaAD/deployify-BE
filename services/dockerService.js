const Docker = require("dockerode");
const docker = new Docker();
const { sendProgress } = require("./progressService");

async function imageExists(imageName) {
    const images = await docker.listImages();
    return images.some(img => img.RepoTags && img.RepoTags.includes(`${imageName}:latest`));
}

async function ensureImageExists(imageName) {
    if (await imageExists(imageName)) return true;

    const pullStream = await docker.pull(imageName);
    return new Promise((resolve, reject) => {
        docker.modem.followProgress(pullStream, (err) => {
            if (err) reject(new Error(`Failed to pull ${imageName} image.`));
            else resolve(true);
        });
    });
}

async function buildImageWithRetry(options, config, maxRetries = 2) {
    let retries = 0;
    let error;

    while (retries <= maxRetries) {
        try {
            const stream = await docker.buildImage(options, config);
            let buildLogs = "";

            return new Promise((resolve, reject) => {
                docker.modem.followProgress(
                    stream,
                    (err, output) => {
                        if (err) {
                            console.error(`Build error: ${err}`);
                            reject(err);
                            return;
                        }

                        console.log(`Build completed for ${config.t}. Last outputs:`);
                        const lastLogs = output.slice(-5).map(o => o.stream || '').join('\n');
                        console.log(lastLogs);

                        resolve(buildLogs);
                    },
                    (event) => {
                        if (event.stream) {
                            buildLogs += event.stream;
                        }
                    }
                );
            });
        } catch (err) {
            error = err;
            console.error(`Build attempt ${retries + 1} failed: ${err.message}`);
            retries++;
        }
    }

    throw error || new Error("Failed to build image after retries");
}

async function createAndStartContainer(containerConfig) {
    const { containerName, exposedPort, image, env = [] } = containerConfig;

    try {
        // Create container with the specified configuration
        const container = await docker.createContainer({
            Image: image,
            name: containerName,
            ExposedPorts: { [`${exposedPort}/tcp`]: {} },
            HostConfig: {
                PortBindings: { [`${exposedPort}/tcp`]: [{ HostPort: exposedPort.toString() }] },
                // Add additional network options here if needed
            },
            Env: [...env, `PORT=${exposedPort}`],
        });

        await container.start();

        // Get container information for logging/debugging
        const containerInfo = await container.inspect();
        console.log(`Container status: ${containerInfo.State.Status}`);
        console.log(`Container ports: ${JSON.stringify(containerInfo.NetworkSettings.Ports)}`);

        return {
            container,
            id: containerInfo.Id,
            status: containerInfo.State.Status
        };
    } catch (error) {
        console.error(`Error creating/starting container: ${error.message}`);
        throw error;
    }
}

async function cleanupContainer(containerName, sessionId, errorMessage) {
    const containers = await docker.listContainers({ all: true });
    const container = containers.find(c => c.Names.includes(`/${containerName}`));

    if (container) {
        const containerObj = docker.getContainer(container.Id);
        try {
            await containerObj.stop({ t: 5 });
        } catch (stopError) { }

        try {
            await containerObj.remove();
        } catch (removeError) { }
    }

    if (sessionId && errorMessage) {
        sendProgress(sessionId, 0, `Error: ${errorMessage}`);
    }

    return errorMessage;
}

module.exports = {
    imageExists,
    ensureImageExists,
    cleanupContainer,
    buildImageWithRetry,
    createAndStartContainer,
    docker
};