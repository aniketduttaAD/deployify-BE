const axios = require('axios');
const { NGROK_APITOKEN, NGROK_AUTHTOKEN } = require('../config');

async function createNgrokReservedAddress(description = 'Deployify Service') {
    const response = await axios.post(
        'https://api.ngrok.com/reserved_addrs',
        { description, region: 'us' },
        {
            headers: {
                'Authorization': `Bearer ${NGROK_APITOKEN}`,
                'Content-Type': 'application/json',
                'Ngrok-Version': '2'
            }
        }
    );
    return response.data.addr;
}

async function createNgrokReservedDomain(subdomain) {
    const domain = `${subdomain}.ngrok.app`;
    const response = await axios.post(
        'https://api.ngrok.com/reserved_domains',
        { domain, region: 'us' },
        {
            headers: {
                'Authorization': `Bearer ${NGROK_APITOKEN}`,
                'Content-Type': 'application/json',
                'Ngrok-Version': '2'
            }
        }
    );
    return response.data.domain;
}

function generateNgrokConfig(authToken, config) {
    const { name, type, url, port } = config;

    let configContent = `version: 3
agent:
  authtoken: ${authToken}
endpoints:
  - name: ${name}
`;

    if (type === 'http') {
        configContent += `    url: ${url}
    upstream:
      url: ${port}`;
    } else if (type === 'tcp') {
        configContent += `    url: ${url}
    upstream:
      url: ${port}
      protocol: tcp`;
    }

    return configContent;
}

module.exports = {
    createNgrokReservedAddress,
    createNgrokReservedDomain,
    generateNgrokConfig
};