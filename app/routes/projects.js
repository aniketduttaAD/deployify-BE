const express = require('express');
const { uploadProject } = require('../controllers/projects');
const router = express.Router();

router.post('/upload', uploadProject);

module.exports = router;
