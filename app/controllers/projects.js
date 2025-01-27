const multer = require('multer');
const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const upload = multer({ dest: 'uploads/' });
const PROJECTS_DIR = path.resolve(__dirname, '../uploads');

const uploadProject = async (req, res) => {
    const ws = req.wss.clients.values().next().value;
    try {
        const { projectName, files } = req.body;

        if (!projectName || !files || !Array.isArray(files)) {
            return res.status(400).json({ error: 'Invalid request data.' });
        }

        const projectPath = `${PROJECTS_DIR}/${projectName}`;
        fs.mkdirSync(projectPath, { recursive: true });

        let completed = 0;
        const totalFiles = files.length;

        for (const file of files) {
            const { path: filePath, content } = file;
            const fullPath = path.join(projectPath, filePath);
            const dir = path.dirname(fullPath);

            fs.mkdirSync(dir, { recursive: true });

            if (content) {
                fs.writeFileSync(fullPath, Buffer.from(content, 'base64'));
            }

            completed++;

            if (ws && ws.readyState === WebSocket.OPEN) {
                const progress = Math.floor((completed / totalFiles) * 100);
                ws.send(JSON.stringify({ status: 'progress', progress }));
            }
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ status: 'success', message: `Project '${projectName}' uploaded successfully!` }));
        }

        res.status(200).json({ message: `Project '${projectName}' uploaded successfully!` });
    } catch (error) {
        console.error('Error uploading project:', error);

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ status: 'error', error: 'An error occurred during upload.' }));
        }

        res.status(500).json({ error: 'An error occurred during upload.' });
    }
};

module.exports = { uploadProject };
