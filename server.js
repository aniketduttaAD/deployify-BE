const express = require("express");
const http = require("http");
const cors = require("cors");
const multer = require("multer");
const { PORT } = require("./config");
const progressService = require("./services/progressService");
const deploymentService = require("./services/deploymentService");
const mongoDeploymentService = require("./services/mongoDeploymentService");

const upload = multer({ dest: "uploads/" });
const app = express();
const server = http.createServer(app);

progressService.init(server);

app.use(cors({
    origin: "*",
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
}));
app.use(express.json());

app.get("/health", (req, res) => {
    res.status(200).json({ message: "Server is running" });
});

app.post("/upload", upload.none(), async (req, res) => {
    const { language } = req.body;
    if (language === "mongodb") {
        return mongoDeploymentService.deployMongoDB(req, res);
    } else {
        return deploymentService.deployApplication(req, res);
    }
});

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log(`WebSocket server is running on ws://localhost:${PORT}`);

    if (!process.env.NGROK_AUTHTOKEN) {
        console.warn("WARNING: NGROK_AUTHTOKEN is not set. Ngrok tunnels will not work.");
    }
});

process.on("SIGINT", () => {
    console.log("Shutting down server...");
    console.log("Server shutdown complete");
    process.exit(0);
});