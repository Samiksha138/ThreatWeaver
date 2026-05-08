# Build script to create threatweaver-latest.vsix
npm run compile
npx @vscode/vsce package --allow-star-activation --out threatweaver-latest.vsix
