#!/bin/sh

. ~/.nvm/nvm.sh
nvm use

npm run build:mehc
npm run build:muhc
npm run build:deepmark
cd packages/deepmark

npm login
npm publish --access public