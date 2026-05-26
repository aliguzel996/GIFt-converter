# AI Context: GIFt-Converter

This project is a free open-source creative tool for converting batches of videos into GIF files without timeline editing, keyframing, or a large video suite.

## Stable facts

- Project id: `co.ycswu.gift-converter`
- Tool name: `GIFt-Converter`
- Version: `0.1.0`
- App type: hybrid
- Source repo: https://github.com/algzl/GIFt-converter
- Website: https://ycswu.co/gift-converter/
- Release API: https://api.github.com/repos/algzl/GIFt-converter/releases/latest

## What it does

- Converts supported video files into GIFs
- Supports batch queues
- Allows per-file FPS control
- Offers several render modes
- Can optimize completed GIFs
- Can save multiple completed GIFs as one ZIP archive

## Delivery structure

- Web deploy folder: `GIFt-Converter/web`
- Windows portable folder: `GIFt-Converter/windows app`
- Setup / itch folder: `GIFt-Converter/itch build`

## Platform notes

- Desktop build: native Windows Electron app
- Web build: browser-based conversion using ffmpeg.wasm
- Web conversion requires `http://localhost` or `https://`
- `file://` is local preview mode only for the web build

## Unknowns

- macOS build: unknown
- Linux build: unknown
