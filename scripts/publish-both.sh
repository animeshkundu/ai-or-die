#!/bin/bash
set -e
echo "Publishing ai-or-die..."
npm publish

echo ""
echo "Publishing aiordie (alias)..."
# Temporarily swap the package name
cp package.json package.json.bak
node -e "
const pkg = require('./package.json');
pkg.name = 'aiordie';
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
npm publish
mv package.json.bak package.json

echo ""
echo "Both packages published!"
echo "  npx ai-or-die"
echo "  npx aiordie"
