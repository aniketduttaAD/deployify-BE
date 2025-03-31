require('dotenv').config();

module.exports = {
    PORT: 5002,
    PROJECTS_DIR: require('path').resolve(__dirname, "uploads"),
    NGROK_AUTHTOKEN: process.env.NGROK_AUTHTOKEN,
    NGROK_APITOKEN: process.env.NGROK_APITOKEN
};