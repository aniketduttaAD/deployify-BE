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
    let lastError;

    while (retries <= maxRetries) {
        try {
            const stream = await docker.buildImage(options, config);
            return new Promise((resolve, reject) => {
                let logs = "";
                docker.modem.followProgress(
                    stream,
                    (err) => {
                        if (err) reject(err);
                        else resolve(logs);
                    },
                    (event) => {
                        if (event.stream) logs += event.stream;
                    }
                );
            });
        } catch (err) {
            lastError = err;
            retries++;
        }
    }

    throw lastError || new Error("Failed to build image after retries");
}

async function createAndStartContainer(containerConfig) {
    const { containerName, exposedPort, image, env = [] } = containerConfig;

    const container = await docker.createContainer({
        Image: image,
        name: containerName,
        ExposedPorts: { [`${exposedPort}/tcp`]: {} },
        HostConfig: {
            PortBindings: { [`${exposedPort}/tcp`]: [{ HostPort: exposedPort.toString() }] },
        },
        Env: [...env, `PORT=${exposedPort}`],
    });

    await container.start();
    const containerInfo = await container.inspect();

    return {
        container,
        id: containerInfo.Id,
        status: containerInfo.State.Status
    };
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