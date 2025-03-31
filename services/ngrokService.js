const axios = require('axios');
const { NGROK_APITOKEN, NGROK_AUTHTOKEN } = require('../config');

async function createNgrokReservedAddress(description) {
    const response = await axios.post(
        'https://api.ngrok.com/reserved_addrs',
        { description: description, region: 'us' },
        {
            headers: {
                'Authorization': `Bearer ${NGROK_APITOKEN}`,
                'Content-Type': 'application/json',
                'Ngrok-Version': '2'
            }
        }
    );
    return response.data;
}

async function createNgrokReservedDomain(domain) {
    const response = await axios.post(
        'https://api.ngrok.com/reserved_domains',
        { domain: domain, region: 'us' },
        {
            headers: {
                'Authorization': `Bearer ${NGROK_APITOKEN}`,
                'Content-Type': 'application/json',
                'Ngrok-Version': '2'
            }
        }
    );
    return response.data;
}

function generateNgrokConfig(authToken, tunnelType, options) {
    let config = `version: 3
agent:
  authtoken: ${authToken}
endpoints:
  - name: tunnel
`;

    if (tunnelType === 'http') {
        config += `    url: ${options.domain}
    upstream:
      url: http://localhost:${options.port}`;
    } else if (tunnelType === 'tcp') {
        config += `    url: tcp://${options.remoteAddr}
    upstream:
      url: tcp://localhost:${options.port}
      protocol: tcp`;
    }

    return config;
}

module.exports = {
    createNgrokReservedAddress,
    createNgrokReservedDomain,
    generateNgrokConfig,
    NGROK_AUTHTOKEN
};