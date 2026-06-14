# Install Oh My Coder

This extension expects the `omp` CLI to be installed and available on your `PATH`.

## 1. Install Bun

Official Bun installation docs: <https://bun.com/docs/installation>

### macOS

Recommended:

```bash
brew install oven-sh/bun/bun
```

Or use the Bun installer:

```bash
curl -fsSL https://bun.com/install | bash
```

### Linux

```bash
curl -fsSL https://bun.com/install | bash
```

If `bun` is not found after install, add it to your shell config:

```bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
```

### Windows (PowerShell)

```powershell
powershell -c "irm bun.sh/install.ps1|iex"
```

After installation, restart your terminal.

### Verify Bun

```bash
bun --version
```

On Windows PowerShell:

```powershell
bun --version
```

## 2. Install OMP with Bun

Install the OMP CLI globally:

```bash
bun install -g @oh-my-pi/pi-coding-agent
```

On Windows PowerShell:

```powershell
bun install -g @oh-my-pi/pi-coding-agent
```

### Verify OMP

```bash
omp --version
```

On Windows PowerShell:

```powershell
omp --version
```

If `omp` is not found, make sure Bun's global bin directory is on your `PATH`.

Typical locations:

- macOS/Linux: `~/.bun/bin`
- Windows: `%USERPROFILE%\.bun\bin`

## 3. Install the extension

### From the VS Code Marketplace

Search for **Oh My Coder** in the Extensions view and install it.

### From a VSIX file

In VS Code:

1. Open the Extensions view.
2. Click the `...` menu.
3. Choose **Install from VSIX...**
4. Select the `oh-my-coder-<version>.vsix` file.

Or from the command line:

```bash
code --install-extension oh-my-coder-0.1.0.vsix --force
```

## 4. Start using Oh My Coder

1. Reload VS Code if needed.
2. Open the **Oh My Coder** activity bar icon.
3. Start or resume an OMP session.

## Troubleshooting

### `omp` not found

- Confirm `bun --version` works.
- Confirm `bun install -g @oh-my-pi/pi-coding-agent` completed successfully.
- Confirm Bun's bin directory is on your `PATH`.
- Restart your shell or VS Code after changing `PATH`.

### VS Code cannot find `omp`

If `omp` is installed but not discoverable from the extension host environment, set the full CLI path in VS Code settings via `omp.path`.

## References

- Bun installation: <https://bun.com/docs/installation>
- OMP installer: <https://omp.sh/install>
