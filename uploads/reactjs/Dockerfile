
                    FROM node:23-alpine3.20
                    WORKDIR /app
                    COPY package.json ./
                    RUN if ! command -v yarn; then npm install -g yarn; fi
                    RUN yarn install
                    RUN node -e "let p=require('./package.json'); if(!p.scripts.build) { p.scripts.build='react-scripts build'; require('fs').writeFileSync('package.json', JSON.stringify(p, null, 2)) }"
                    COPY . .
                    RUN yarn run build
                    RUN npm install -g serve
                    EXPOSE 30973
                    CMD ["serve", "-s", "build"]
                    