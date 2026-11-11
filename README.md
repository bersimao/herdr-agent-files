# Open in Explorer

![Open in Explorer](preview.png)

A [Herdr](https://herdr.dev) desktop mod that opens any file or folder from your terminal in the desktop file manager: **Explorer** on Windows, **Finder** on macOS, your default file manager on Linux. Type a path, press Enter, done.

## Features

- **One dialog, one key.** `ctrl-shift-e` opens a small dialog; Esc closes it. It works from any space, including a WSL or SSH machine space.
- **Starts where your terminal is.** Relative paths resolve against the focused terminal's folder, and `~` works. **Terminal folder** opens that folder in one click.
- **Reveals files, never launches them.** A folder is opened; a file is shown selected in its folder (`explorer.exe /select,` on Windows, `open -R` on macOS, the parent folder on Linux). Nothing you type can start a program.
- **Understands your paths.** On a Windows desktop it accepts `C:\x` and Linux paths from a WSL machine, and converts them (`\\wsl.localhost\...`). Missing paths and relative paths with no known terminal folder show a clear message instead of opening the wrong place.
- **Small and readable.** One `main.js`, one PowerShell helper for Windows, no dependencies, no network.

## Requirements

- The Herdr desktop app on Windows, macOS or Linux.
- Windows: PowerShell (built in). A WSL machine space also needs `wslpath` (built into WSL).

## Install

With the app open, ask the agent in your Herdr window to *add the mod at github.com/bersimao/herdr-open-in-explorer*, or do it by hand:

```sh
git clone https://github.com/bersimao/herdr-open-in-explorer.git
cp -r herdr-open-in-explorer/mods/open-in-explorer ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/open-in-explorer
```

Then merge this repository's `keys.json` into `~/.config/herdr-app/keys.json` (skip it if you already use `ctrl-shift-e`), or open the dialog without a key:

```sh
herdr-app do mod.open --name open-in-explorer
```

## Keys

| Key | Does |
| --- | --- |
| `ctrl-shift-e` | Open (or close) the dialog |
| `Enter` in the path box | Open the path |
| `Esc` | Close the dialog |

## How it works

Paths are resolved where the terminal runs (`exec` on the terminal's machine) and opened locally, because the file manager belongs to the desktop you are looking at.

| Desktop | Resolves with | Opens with |
| --- | --- | --- |
| Windows, local terminal | `resolve.ps1` | `explorer.exe` |
| Windows, WSL machine space | `sh` + `wslpath` | `explorer.exe` |
| macOS, local terminal | `sh` | `open` / `open -R` |
| Linux, local terminal | `sh` | `xdg-open` |

Remote machines on a macOS or Linux desktop are not supported: their files are not on your desktop, and the dialog says so.

## Tested

Windows (local terminal and WSL machine space) is tested. The macOS and Linux paths are written to the same shape but untested on real machines. Reports and fixes are welcome.

[RECIPE.md](RECIPE.md) is the brief to build this mod from scratch.

## License

[MIT](LICENSE).
