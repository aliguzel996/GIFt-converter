# GIFt-Converter

GIFt-Converter is a free open-source creative tool for converting batches of videos into GIFs without timeline editing or a larger video suite.

## What it is

This project ships in two forms:

- a Windows desktop app
- a browser-based web build

Both focus on the same job: import video files, convert them to GIFs, and save the results as single GIF files or ZIP bundles.

## Use

Local development:

```bash
npm install
npm start
```

Build all release targets:

```bash
npm run package:all
```

## Download and releases

- Website: https://ycswu.co/gift-converter/
- GitHub repository: https://github.com/algzl/GIFt-converter
- Latest releases: https://github.com/algzl/GIFt-converter/releases/latest
- Windows setup download: https://github.com/algzl/GIFt-converter/releases/latest/download/gift-converter-setup.exe

## Release structure

- Web deploy folder: `GIFt-Converter/web`
- Windows portable folder: `GIFt-Converter/windows app`
- Setup / itch folder: `GIFt-Converter/itch build`

## Metadata

Machine-readable project metadata lives in:

- `app.manifest.json`
- `metadata/manifest/tool.manifest.json`
- `metadata/schema/software-application.schema.json`
- `metadata/ai/context.md`
- `AI.md`
- `llms.txt`

These files exist for release tooling, GitHub context, AI agents, and future YCSWU Tools Hub integration. They are not exposed as a visible in-app SEO section.
